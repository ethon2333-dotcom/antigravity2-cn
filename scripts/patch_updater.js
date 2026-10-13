'use strict';

const vm = require('vm');

function replaceOnce(content, target, replacement, label) {
    if (content.split(target).length !== 2) throw new Error(label + ': expected exactly one patch target');
    return content.replace(target, replacement);
}

function patchUpdaterContent(content, useTW = false) {
    const menuActions = `exports.updateActions = {
    [MenuUpdateStep.CheckForUpdates]: () => checkForUpdates(true),
    [MenuUpdateStep.CheckingForUpdates]: undefined,
    [MenuUpdateStep.DownloadingUpdate]: undefined,
    [MenuUpdateStep.RestartToUpdate]: () => quitAndInstall(),
};`;
    content = replaceOnce(content, menuActions, menuActions.replace('\n};', `
    '检查更新': () => checkForUpdates(true),
    '檢查更新': () => checkForUpdates(true),
    '重启以更新': () => quitAndInstall(),
    '重啟以更新': () => quitAndInstall(),
};`), 'update menu');
    const options = `                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],`;
    content = replaceOnce(content, options, useTW
        ? `                title: '檢查更新',
                message: '目前沒有可用的更新',
                buttons: ['好'],`
        : `                title: '检查更新',
                message: '暂无可用更新',
                buttons: ['确定'],`, 'update dialog');
    const settings = `    electron_updater_1.autoUpdater.autoDownload = true;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = electron_1.app.isPackaged;`;
    content = replaceOnce(content, settings, settings + `
    const macFallback = require('./mac_update_fallback').configureMacUpdateFallback(
        electron_updater_1.autoUpdater, electron_1.app, (err) => {
            console.error('[AutoUpdater] Safe fallback failed:', err);
            electron_1.dialog.showErrorBox('Antigravity update failed', String(err.message || err));
        });
    electron_updater_1.autoUpdater.on('update-available', () => macFallback.reset());`, 'updater initialization');
    const downloaded = `    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        console.log(\`[AutoUpdater] Update downloaded: \${info.version}\`);`;
    content = replaceOnce(content, downloaded, downloaded + '\n        macFallback.recordDownload(info);', 'download event');
    const error = `    electron_updater_1.autoUpdater.on('error', (err) => {
        console.error('[AutoUpdater] Error:', err.message);
        broadcastState({ type: types_1.UpdateState.Idle });
        updateMenuState(MenuUpdateStep.CheckForUpdates);
        isManualCheck = false;
    });`;
    content = replaceOnce(content, error, `    electron_updater_1.autoUpdater.on('error', (err) => {
        console.error('[AutoUpdater] Error:', err.message);
        if (macFallback.handleError(err)) {
            // Retain the downloaded version already broadcast by update-downloaded.
            updateMenuState(MenuUpdateStep.RestartToUpdate);
            isManualCheck = false;
            if (isHeadless) electron_updater_1.autoUpdater.quitAndInstall();
            return;
        }
        macFallback.reset();
        broadcastState({ type: types_1.UpdateState.Idle });
        updateMenuState(MenuUpdateStep.CheckForUpdates);
        isManualCheck = false;
    });`, 'error event');
    new vm.Script(content, { filename: 'patched-updater.js' });
    return content;
}

module.exports = { patchUpdaterContent };
