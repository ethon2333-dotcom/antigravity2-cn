'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

// Google LLC's Developer ID, verified against the official Antigravity release.
const GOOGLE_REQUIREMENT = 'identifier "com.google.antigravity" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "EQHXZ8M8AV"';

// Paths are positional arguments, never interpolated into shell source. All moves
// stay on the same filesystem. Keep the backup and download for recovery.
const INSTALL_SCRIPT = `
parent_pid=$1
app=$2
candidate=$3
backup=$4
attempts=0
while kill -0 "$parent_pid" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 120 ]; then
        echo "Application did not quit; update cancelled. Staged files retained."
        exit 1
    fi
    sleep 0.5
done
if ! /bin/mv "$app" "$backup"; then
    echo "Could not preserve current application; update cancelled."
    exit 1
fi
if ! /bin/mv "$candidate" "$app"; then
    echo "Could not install update; restoring previous application."
    if /bin/mv "$backup" "$app"; then
        /usr/bin/open "$app"
    else
        echo "Rollback failed. Previous application is preserved at: $backup"
    fi
    exit 1
fi
echo "Update installed. Previous application preserved at: $backup"
/usr/bin/open "$app"
`;

function signatureInfo(bundlePath) {
    const result = childProcess.spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath], { encoding: 'utf8' });
    return result.status === 0 ? String(result.stdout || '') + String(result.stderr || '') : '';
}

function prepareUpdate(info, appBundlePath) {
    if (!info || typeof info.downloadedFile !== 'string' || !path.isAbsolute(info.downloadedFile) ||
        typeof info.version !== 'string' || !fs.statSync(info.downloadedFile).isFile()) {
        throw new Error('No verified downloaded update is available. Check for updates again.');
    }
    // Extraction and verification happen before quitting or touching the old app.
    // mkdtemp also verifies that the user can write to the application directory.
    const stageDir = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(appBundlePath), '.antigravity-update-')));
    try {
        childProcess.execFileSync('/usr/bin/ditto', ['-x', '-k', info.downloadedFile, stageDir], { stdio: 'pipe' });
        const candidate = path.join(stageDir, 'Antigravity.app');
        if (!fs.lstatSync(candidate).isDirectory() || fs.realpathSync(candidate) !== candidate) {
            throw new Error('Update archive does not contain a regular Antigravity.app bundle.');
        }
        childProcess.execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=' + GOOGLE_REQUIREMENT, candidate], { stdio: 'pipe' });
        const version = childProcess.execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(candidate, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
        if (version !== info.version) throw new Error('Downloaded application version does not match the update event.');
        return { stageDir, candidate, backup: path.join(stageDir, 'previous.app') };
    } catch (err) {
        fs.rmSync(stageDir, { recursive: true, force: true });
        throw err;
    }
}

function configureMacUpdateFallback(autoUpdater, app, onFailure) {
    const inactive = { recordDownload() {}, reset() {}, handleError() { return false; } };
    if (process.platform !== 'darwin' || !app.isPackaged) return inactive;
    const appBundlePath = path.resolve(process.execPath, '../../..');
    const signature = signatureInfo(appBundlePath);
    if (!/^Signature=adhoc$/m.test(signature) || !/^Identifier=com\.google\.antigravity$/m.test(signature)) return inactive;

    let downloadedInfo = null;
    let signatureFailed = false;
    let installing = false;
    const originalQuitAndInstall = autoUpdater.quitAndInstall.bind(autoUpdater);
    // Preserve the official updater's settings and try its normal installation
    // first. A pending Squirrel update alone must never enable the fallback.
    autoUpdater.quitAndInstall = (...args) => {
        if (!signatureFailed) return originalQuitAndInstall(...args);
        if (installing) return;
        installing = true;
        let prepared;
        let logFd;
        try {
            prepared = prepareUpdate(downloadedInfo, appBundlePath);
            logFd = fs.openSync(path.join(prepared.stageDir, 'installer.log'), 'a', 0o600);
            const child = childProcess.spawn('/bin/sh', ['-c', INSTALL_SCRIPT, 'antigravity-update', String(process.pid), appBundlePath, prepared.candidate, prepared.backup], {
                detached: true,
                stdio: ['ignore', logFd, logFd],
            });
            fs.closeSync(logFd);
            logFd = undefined;
            child.once('error', err => {
                installing = false;
                // Preserve the verified candidate and log if the helper fails.
                onFailure(err);
            });
            child.once('spawn', () => {
                console.log('[AutoUpdater] Verified fallback staged at: ' + prepared.stageDir);
                child.unref();
                app.quit();
            });
        } catch (err) {
            if (logFd !== undefined) fs.closeSync(logFd);
            installing = false;
            onFailure(err);
        }
    };
    return {
        recordDownload(info) {
            downloadedInfo = info;
            signatureFailed = false;
        },
        reset() {
            downloadedInfo = null;
            signatureFailed = false;
        },
        handleError(err) {
            const message = String((err && err.message) || err);
            if (!downloadedInfo || !/Code signature|did not pass validation|代码未能满足/i.test(message) ||
                typeof downloadedInfo.downloadedFile !== 'string' || !fs.existsSync(downloadedInfo.downloadedFile)) return false;
            signatureFailed = true;
            return true;
        },
    };
}

module.exports = { configureMacUpdateFallback, prepareUpdate, INSTALL_SCRIPT, GOOGLE_REQUIREMENT };
