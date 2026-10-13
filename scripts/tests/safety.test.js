'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { patchUpdaterContent } = require('../patch_updater');
const { INSTALL_SCRIPT } = require('../mac_update_fallback');
const retrySource = fs.readFileSync(path.join(__dirname, '../auto_retry.js'), 'utf8');
const helperSource = fs.readFileSync(path.join(__dirname, '../mac_update_fallback.js'), 'utf8');
const updaterSource = fs.readFileSync(path.join(__dirname, 'fixtures/updater.js'), 'utf8');
const quiet = { log() {}, error() {} };

function retryFixture(label, inError = true) {
    const box = { isConnected: true, getBoundingClientRect: () => ({ width: 100, height: 100 }) };
    const body = {};
    let currentBox = inError ? box : null;
    const button = { innerText: label, isConnected: true, disabled: false, clicks: 0, getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 20, height: 20 }), closest: () => currentBox, parentElement: body,
        click() { this.clicks++; } };
    let poll, delayed;
    vm.runInNewContext(retrySource, { document: { readyState: 'complete', querySelectorAll: () => [button], body },
        window: { getComputedStyle: () => ({}) }, setInterval: fn => { poll = fn; }, setTimeout: fn => { delayed = fn; }, Date, console: quiet });
    return { button, poll, runDelay: () => { if (delayed) delayed(); }, clearError: () => { currentBox = null; }, replaceError: () => { currentBox = { ...box }; } };
}

for (const label of ['Retry', 'Try Again', '重试', '重試', '再试一次', '再試一次']) {
    test('retry supports ' + label + ' inside an error', () => {
        const f = retryFixture(label); f.poll(); f.runDelay(); assert.equal(f.button.clicks, 1);
    });
}
for (const label of ['Resume', '恢复', '恢復', 'Cancel', 'Do not retry', 'Retry later']) {
    test('does not click ' + label, () => {
        const f = retryFixture(label); f.poll(); f.runDelay(); assert.equal(f.button.clicks, 0);
    });
}
test('retry outside an error remains untouched', () => {
    const f = retryFixture('Retry', false); f.poll(); f.runDelay(); assert.equal(f.button.clicks, 0);
});
for (const [name, mutate] of [
    ['action changed', f => { f.button.innerText = 'Cancel'; }],
    ['disabled', f => { f.button.disabled = true; }],
    ['aria disabled', f => { f.button.getAttribute = name => name === 'aria-disabled' ? 'true' : null; }],
    ['removed', f => { f.button.isConnected = false; }],
    ['error cleared', f => f.clearError()],
    ['error replaced', f => f.replaceError()],
]) {
    test('revalidates delayed click: ' + name, () => {
        const f = retryFixture('Retry'); f.poll(); mutate(f); f.runDelay(); assert.equal(f.button.clicks, 0);
    });
}
test('visible cancel label overrides stale Retry aria-label', () => {
    const f = retryFixture('Cancel'); f.button.getAttribute = () => 'Retry'; f.poll(); f.runDelay(); assert.equal(f.button.clicks, 0);
});
test('injection cleanup removes old and new retry blocks without duplication', () => {
    const { cleanJsContent, AUTO_RETRY_CODE } = require('../../localization_engine');
    const original = 'const original = true;\n';
    assert.equal(cleanJsContent(original + AUTO_RETRY_CODE + AUTO_RETRY_CODE).trim(), original.trim());
});

test('both languages patch all updater targets and preserve official settings', () => {
    for (const tw of [false, true]) {
        const out = patchUpdaterContent(updaterSource, tw); new vm.Script(out);
        assert.ok(out.includes('autoInstallOnAppQuit = electron_1.app.isPackaged;'));
        assert.ok(out.includes(tw ? '目前沒有可用的更新' : '暂无可用更新'));
    }
});
test('unsupported or duplicated updater targets fail before writing any patch', () => {
    assert.throws(() => patchUpdaterContent(updaterSource.replace('autoDownload = true', 'autoDownload = false')), /initialization/);
    assert.throws(() => patchUpdaterContent(updaterSource + updaterSource), /exactly one/);
});

function helperFixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-safety-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const appPath = path.join(root, 'Antigravity.app'); fs.mkdirSync(appPath);
    const zip = path.join(root, 'download.zip'); fs.writeFileSync(zip, 'mock verified download');
    const calls = []; const child = new EventEmitter(); child.unref = () => calls.push('unref');
    const childProcess = {
        spawnSync: () => ({ status: options.signatureStatus ?? 0, stderr: options.signature ?? 'Signature=adhoc\nIdentifier=com.google.antigravity\n' }),
        execFileSync(command, args) {
            calls.push([command, args]);
            if (command.endsWith('ditto')) {
                if (options.extractFails) throw Error('invalid zip');
                fs.mkdirSync(path.join(args[3], 'Antigravity.app'));
            } else if (command.endsWith('codesign')) {
                if (options.signatureFails) throw Error('invalid Google signature');
            } else if (command.endsWith('plutil')) return options.version ?? '2.24.0\n';
        },
        spawn(command, args) { calls.push([command, args]); return child; },
    };
    const module = { exports: {} };
    vm.runInNewContext(helperSource, { module, require: name => name === 'child_process' ? childProcess : require(name),
        process: { platform: options.platform ?? 'darwin', execPath: path.join(appPath, 'Contents/MacOS/Antigravity'), pid: 12345 }, console: quiet });
    let normal = 0, quit = 0; const failures = [];
    const auto = { quitAndInstall: () => normal++ };
    const app = { isPackaged: options.packaged ?? true, quit: () => quit++ };
    const controller = module.exports.configureMacUpdateFallback(auto, app, err => failures.push(err));
    const info = { downloadedFile: zip, version: '2.24.0' };
    return { root, appPath, zip, info, auto, controller, calls, child, failures, api: module.exports, counts: () => ({ normal, quit }) };
}
for (const options of [ { platform: 'win32' }, { platform: 'linux' }, { packaged: false }, { signature: 'Identifier=com.google.antigravity\nTeamIdentifier=EQHXZ8M8AV\n' }, { signatureStatus: 1 }, { signature: 'Signature=adhoc\nIdentifier=other.app\n' } ]) {
    test('official updater stays active for ' + JSON.stringify(options), t => {
        const f = helperFixture(t, options); f.controller.recordDownload(f.info);
        assert.equal(f.controller.handleError(Error('Code signature did not pass validation')), false);
        f.auto.quitAndInstall(); assert.equal(f.counts().normal, 1); assert.equal(f.calls.length, 0);
    });
}
test('ad-hoc app without signature error still uses official installer', t => {
    const f = helperFixture(t); f.controller.recordDownload(f.info); f.auto.quitAndInstall();
    assert.equal(f.counts().normal, 1); assert.equal(f.controller.handleError(Error('network timeout')), false); assert.equal(f.calls.length, 0);
});
test('no fallback without a current downloaded file', t => {
    const f = helperFixture(t); assert.equal(f.controller.handleError(Error('Code signature invalid')), false);
    f.controller.recordDownload(f.info); fs.unlinkSync(f.zip); assert.equal(f.controller.handleError(Error('Code signature invalid')), false);
});
test('new update clears stale fallback authorization', t => {
    const f = helperFixture(t); f.controller.recordDownload(f.info); assert.equal(f.controller.handleError(Error('Code signature invalid')), true);
    f.controller.reset(); f.auto.quitAndInstall(); assert.equal(f.counts().normal, 1); assert.equal(f.calls.length, 0);
});
for (const options of [{ extractFails: true }, { signatureFails: true }, { version: '9.0.0' }]) {
    test('invalid download leaves running app untouched: ' + JSON.stringify(options), t => {
        const f = helperFixture(t, options); f.controller.recordDownload(f.info); f.controller.handleError(Error('Code signature invalid')); f.auto.quitAndInstall();
        assert.equal(f.counts().quit, 0); assert.equal(f.failures.length, 1); assert.ok(fs.existsSync(f.appPath)); assert.ok(fs.existsSync(f.zip));
        assert.equal(fs.readdirSync(f.root).filter(x => x.startsWith('.antigravity-update-')).length, 0);
    });
}
test('fallback verifies Google identity and waits for helper startup before quitting', t => {
    const f = helperFixture(t); f.controller.recordDownload(f.info); f.controller.handleError(Error('Code signature invalid')); f.auto.quitAndInstall();
    const verify = f.calls.find(x => Array.isArray(x) && x[0].endsWith('codesign'));
    assert.ok(verify[1].includes('=' + f.api.GOOGLE_REQUIREMENT)); assert.ok(f.api.GOOGLE_REQUIREMENT.includes('EQHXZ8M8AV'));
    assert.equal(f.counts().quit, 0); f.child.emit('spawn'); assert.equal(f.counts().quit, 1);
    f.auto.quitAndInstall(); assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === '/bin/sh').length, 1);
});
test('helper startup failure preserves current app and download', t => {
    const f = helperFixture(t); f.controller.recordDownload(f.info); f.controller.handleError(Error('Code signature invalid')); f.auto.quitAndInstall();
    f.child.emit('error', Error('spawn failed')); assert.equal(f.counts().quit, 0); assert.equal(f.failures.length, 1);
    assert.ok(fs.existsSync(f.appPath)); assert.ok(fs.existsSync(f.zip));
});

test('patched event flow retains ready state only for eligible signature failure', () => {
    const auto = new EventEmitter(); auto.quitAndInstall = () => {};
    let enabled = false;
    const exports = {};
    vm.runInNewContext(patchUpdaterContent(updaterSource), { exports, console: quiet, process: { platform: 'darwin' }, require(name) {
        if (name === 'electron-updater') return { autoUpdater: auto };
        if (name === 'electron') return { app: { isPackaged: true }, dialog: { showErrorBox() {} } };
        if (name === './types') return { UpdateState: { Ready: 'ready', Idle: 'idle' } };
        if (name === './mac_update_fallback') return { configureMacUpdateFallback: () => ({ recordDownload() {}, reset() { enabled = false; }, handleError: () => enabled }) };
        throw Error(name);
    } });
    exports.initAutoUpdater(false); auto.emit('update-downloaded', { version: '2.24.0' }); enabled = true;
    auto.emit('error', Error('Code signature invalid')); assert.equal(exports.getLastState().type, 'ready');
    enabled = false; auto.emit('error', Error('network failure')); assert.equal(exports.getLastState().type, 'idle');
});

// Execute the actual shell transaction in scratch directories. Only the move
// and launch commands are substituted to inject failures deterministically.
for (const failure of [0, 1, 2, 3]) {
    test('installer transaction with failure mode ' + failure, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-transaction-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const app = path.join(root, 'Antigravity $(touch INJECTED).app');
        const candidate = path.join(root, 'new.app'); const backup = path.join(root, 'previous.app');
        for (const [dir, value] of [[app, 'old'], [candidate, 'new']]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'marker'), value); }
        const move = path.join(root, 'move'); const counter = path.join(root, 'counter');
        fs.writeFileSync(move, `#!/bin/sh\ncount=0\n[ ! -f "$MOVE_COUNTER" ] || count=$(cat "$MOVE_COUNTER")\ncount=$((count + 1))\necho "$count" > "$MOVE_COUNTER"\nif [ "$FAIL_MOVE" = "$count" ] || { [ "$FAIL_MOVE" = 3 ] && [ "$count" -ge 2 ]; }; then exit 1; fi\nexec /bin/mv "$@"\n`, { mode: 0o755 });
        const script = INSTALL_SCRIPT.replaceAll('/bin/mv', '"' + move + '"').replaceAll('/usr/bin/open', '/usr/bin/true');
        const result = cp.spawnSync('/bin/sh', ['-c', script, 'update-test', '2147483647', app, candidate, backup], { cwd: root, env: { ...process.env, MOVE_COUNTER: counter, FAIL_MOVE: String(failure) }, encoding: 'utf8' });
        assert.equal(result.status, failure === 0 ? 0 : 1, result.stderr);
        assert.ok(!fs.existsSync(path.join(root, 'INJECTED')));
        if (failure === 0) { assert.equal(fs.readFileSync(path.join(app, 'marker'), 'utf8'), 'new'); assert.equal(fs.readFileSync(path.join(backup, 'marker'), 'utf8'), 'old'); }
        else if (failure < 3) { assert.equal(fs.readFileSync(path.join(app, 'marker'), 'utf8'), 'old'); assert.equal(fs.readFileSync(path.join(candidate, 'marker'), 'utf8'), 'new'); }
        else { assert.equal(fs.readFileSync(path.join(backup, 'marker'), 'utf8'), 'old'); assert.equal(fs.readFileSync(path.join(candidate, 'marker'), 'utf8'), 'new'); }
    });
}

test('unsupported updater restores exact installed archive after backup restoration', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-engine-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.resolve(__dirname, '../..');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(repo, 'scripts/auto_retry.js'), path.join(root, 'scripts/auto_retry.js'));
    fs.cpSync(path.join(repo, 'dicts'), path.join(root, 'dicts'), { recursive: true });
    const resources = path.join(root, 'resources'); fs.mkdirSync(resources);
    const installed = Buffer.from('/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */ installed archive');
    const official = Buffer.from('official archive');
    fs.writeFileSync(path.join(resources, 'app.asar'), installed);
    fs.writeFileSync(path.join(resources, 'app.asar.bak'), official);
    const fakeChildProcess = { execSync(command) {
        assert.ok(command.startsWith('npx -y @electron/asar extract'));
        assert.deepEqual(fs.readFileSync(path.join(resources, 'app.asar')), official);
        const dist = path.join(root, '_temp_asar/dist'); fs.mkdirSync(dist, { recursive: true });
        fs.writeFileSync(path.join(dist, 'preload.js'), 'const original = true;');
        fs.writeFileSync(path.join(dist, 'updater.js'), 'const unsupportedVersion = true;');
        return '';
    } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(repo, 'localization_engine.js'), 'utf8'), {
        module, __dirname: root, Buffer, console: quiet,
        process: { platform: 'linux', argv: [], env: {}, execPath: process.execPath },
        require: name => name === 'child_process' ? fakeChildProcess : name === './scripts/patch_updater' ? { patchUpdaterContent } : require(name),
    });
    assert.equal(module.exports.install20(resources), false);
    assert.deepEqual(fs.readFileSync(path.join(resources, 'app.asar')), installed);
    assert.ok(!fs.existsSync(path.join(root, '_temp_asar')));
});
