import fs from 'fs';
import path from 'path';

export function parseFirefoxProfileLockPid(target) {
    if (typeof target !== 'string') return null;
    const match = target.match(/\+(\d+)$/);
    if (!match) return null;
    const pid = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'EPERM') return true;
        if (error?.code === 'ESRCH') return false;
        return true;
    }
}

function unlinkIfFileOrSymlink(filePath) {
    try {
        const info = fs.lstatSync(filePath);
        if (info.isFile() || info.isSymbolicLink()) {
            fs.unlinkSync(filePath);
            return true;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return false;
}

export function cleanupStaleFirefoxProfileLock(
    userDataDir,
    { isPidAlive = defaultIsPidAlive } = {}
) {
    const lockPath = path.join(userDataDir, 'lock');
    const parentLockPath = path.join(userDataDir, '.parentlock');

    let info;
    try {
        info = fs.lstatSync(lockPath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { removed: false, reason: 'no-lock' };
        }
        throw error;
    }

    if (!info.isSymbolicLink()) {
        return { removed: false, reason: 'lock-not-symlink' };
    }

    const target = fs.readlinkSync(lockPath);
    const pid = parseFirefoxProfileLockPid(target);
    if (!pid) {
        return { removed: false, reason: 'unrecognized-lock-target', target };
    }

    if (isPidAlive(pid)) {
        return { removed: false, reason: 'owner-alive', pid };
    }

    let currentTarget;
    try {
        currentTarget = fs.readlinkSync(lockPath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { removed: false, reason: 'lock-disappeared', pid };
        }
        throw error;
    }
    if (currentTarget !== target) {
        return { removed: false, reason: 'lock-changed', pid };
    }

    fs.unlinkSync(lockPath);
    const removedParentLock = unlinkIfFileOrSymlink(parentLockPath);
    return { removed: true, pid, removedParentLock };
}
