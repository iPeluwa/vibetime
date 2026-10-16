import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  installZcodeHooks,
  mergeZcodeHooks,
  stripZcodeHooks,
} = await import('../dist/zcode-hooks.js');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-zcode-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function otherGroup(command = './hooks/format.sh') {
  return { hooks: [{ type: 'command', command, timeoutMs: 5000 }] };
}

const ZCODE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];

function vibeGroup(config, event) {
  return config.hooks.events[event].find((group) => group.hooks[0].command.includes('--tool zcode'));
}

test('ZCode hooks merge non-destructively and are idempotent', () => {
  const unrelated = otherGroup();
  const config = {
    plugins: { enabledPlugins: { 'computer-use@zcode-plugins-official': true } },
    hooks: {
      timeoutMs: 20000,
      events: {
        Stop: [unrelated],
        PreToolUse: [otherGroup('./hooks/approve.sh')],
      },
    },
  };

  const first = mergeZcodeHooks(config);
  assert.equal(first.added, 4);
  assert.equal(first.existing, 0);
  assert.deepEqual(first.config.plugins, { enabledPlugins: { 'computer-use@zcode-plugins-official': true } });
  assert.equal(first.config.hooks.timeoutMs, 20000);
  assert.equal(first.config.hooks.events.Stop[0], unrelated);
  assert.equal(first.config.hooks.events.PreToolUse.length, 1);

  assert.match(vibeGroup(first.config, 'SessionStart').hooks[0].command, /__hook session-start --tool zcode$/);
  assert.match(vibeGroup(first.config, 'UserPromptSubmit').hooks[0].command, /__hook activity --tool zcode$/);
  assert.match(vibeGroup(first.config, 'PostToolUse').hooks[0].command, /__hook activity --tool zcode$/);
  assert.match(vibeGroup(first.config, 'Stop').hooks[0].command, /__hook activity --tool zcode$/);
  for (const event of ZCODE_EVENTS) {
    assert.equal(vibeGroup(first.config, event).hooks[0].type, 'command');
    assert.equal(vibeGroup(first.config, event).hooks[0].timeoutMs, 10000);
    assert.equal('matcher' in vibeGroup(first.config, event), false);
  }
  assert.equal('SessionEnd' in first.config.hooks.events, false);

  const second = mergeZcodeHooks(first.config);
  assert.equal(second.added, 0);
  assert.equal(second.existing, 4);
  assert.equal(second.updated, 0);
});

test('ZCode reinstall refreshes stale commands without duplicating hooks', () => {
  const first = mergeZcodeHooks({});
  vibeGroup(first.config, 'SessionStart').hooks[0].command = "'/old/node' '/old/vibe' __hook session-start --tool zcode";

  const second = mergeZcodeHooks(first.config);
  const ours = second.config.hooks.events.SessionStart.filter((group) => group.hooks[0].command.includes('--tool zcode'));

  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(ours.length, 1);
  assert.doesNotMatch(ours[0].hooks[0].command, /old\/node/);
});

test('ZCode hook removal preserves unrelated hooks and the rest of the config', () => {
  const config = mergeZcodeHooks({
    plugins: { enabledPlugins: {} },
    hooks: { events: { Stop: [otherGroup()] } },
  }).config;

  const { config: stripped, removed } = stripZcodeHooks(config);
  assert.equal(removed, 4);
  assert.deepEqual(stripped.plugins, { enabledPlugins: {} });
  assert.deepEqual(stripped.hooks, { events: { Stop: [otherGroup()] } });

  const { config: empty } = stripZcodeHooks(mergeZcodeHooks({ plugins: {} }).config);
  assert.deepEqual(empty, { plugins: {} });
});

test('ZCode installer never clobbers an invalid config.json', (t) => {
  const path = join(scratch(t), 'config.json');
  writeFileSync(path, '{ definitely not json\n');

  const originalLog = console.log;
  console.log = () => {};
  try {
    installZcodeHooks(path);
  } finally {
    console.log = originalLog;
  }

  assert.equal(readFileSync(path, 'utf8'), '{ definitely not json\n');
});

test('ZCode installer writes a fresh config when none exists', (t) => {
  const path = join(scratch(t), 'cli', 'config.json');

  const originalLog = console.log;
  console.log = () => {};
  try {
    installZcodeHooks(path);
  } finally {
    console.log = originalLog;
  }

  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(written.hooks.events).sort(), [...ZCODE_EVENTS].sort());
});
