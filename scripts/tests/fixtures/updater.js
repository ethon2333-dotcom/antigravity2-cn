// Minimal compatibility fixture for the updater shapes patched by the engine.
const electron_updater_1 = require('electron-updater');
const electron_1 = require('electron');
const types_1 = require('./types');
const MenuUpdateStep = { CheckForUpdates: 'Check for Updates', CheckingForUpdates: 'Checking for Updates...', DownloadingUpdate: 'Downloading Update...', RestartToUpdate: 'Restart to Update' };
exports.updateActions = {
    [MenuUpdateStep.CheckForUpdates]: () => checkForUpdates(true),
    [MenuUpdateStep.CheckingForUpdates]: undefined,
    [MenuUpdateStep.DownloadingUpdate]: undefined,
    [MenuUpdateStep.RestartToUpdate]: () => quitAndInstall(),
};
let isManualCheck = false;
let lastState;
function broadcastState(state) { lastState = state; }
function updateMenuState(step) { exports.menuState = step; }
function checkForUpdates() {}
function quitAndInstall() { electron_updater_1.autoUpdater.quitAndInstall(); }
function headlessQuitAndInstall() {}
function initAutoUpdater(isHeadless) {
    electron_updater_1.autoUpdater.autoDownload = true;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = electron_1.app.isPackaged;
    electron_updater_1.autoUpdater.on('update-not-available', () => {
        const options = {
                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],
        };
    });
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
        if (isHeadless) {
            // Proceed to auto install in headless mode
            if (electron_1.app.isPackaged) {
                if (process.platform === 'linux') {
                    const downloadedFilePath = info.downloadedFile;
                    headlessQuitAndInstall(downloadedFilePath);
                }
                else {
                    electron_updater_1.autoUpdater.quitAndInstall();
                }
            }
            else {
                console.log('[AutoUpdater] Headless mode: Skipping quitAndInstall (not packaged).');
            }
            return;
        }
        broadcastState({
            type: types_1.UpdateState.Ready,
            update: { version: info.version },
        });
        updateMenuState(MenuUpdateStep.RestartToUpdate);
    });
    electron_updater_1.autoUpdater.on('error', (err) => {
        console.error('[AutoUpdater] Error:', err.message);
        broadcastState({ type: types_1.UpdateState.Idle });
        updateMenuState(MenuUpdateStep.CheckForUpdates);
        isManualCheck = false;
    });
}
exports.initAutoUpdater = initAutoUpdater;
exports.getLastState = () => lastState;
