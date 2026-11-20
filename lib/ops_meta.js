'use strict';

const fsPromises = require('node:fs/promises');
const pathModule = require('node:path');
const { F_OK } = require('./constants');
const { UringStats } = require('./stats');
const { normalizePath } = require('./validators');
const { executeBackendOp, withProviderHandle } = require('./backend');

async function dispatchSimpleMetaOp(
  opName,
  filePath,
  options,
  nativeFn,
  workerArgsFn,
  providerFn,
  transformFn,
  callerFn
) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  const normalized = Array.isArray(filePath) ? filePath.map(normalizePath) : normalizePath(filePath);
  let isProvider = false;

  const res = await executeBackendOp({
    options,
    signal,
    callerFn: callerFn || dispatchSimpleMetaOp,
    onProvider: (provider) => {
      isProvider = true;
      return providerFn(provider, normalized, signal);
    },
    onWorker: (pool) => pool.exec(opName, workerArgsFn(normalized)),
    onNative: (native) => nativeFn(native, normalized),
  });

  if (isProvider) {
    return res;
  }
  return transformFn ? transformFn(res) : undefined;
}

async function stat(filePath, options) {
  return await dispatchSimpleMetaOp(
    'stat',
    filePath,
    options,
    (n, p) => n.stat(p),
    (p) => [p],
    (pr, p) => pr.stat(p),
    (raw) => new UringStats(raw),
    stat
  );
}

async function lstat(filePath, options) {
  return await dispatchSimpleMetaOp(
    'lstat',
    filePath,
    options,
    (n, p) => n.lstat(p),
    (p) => [p],
    (pr, p) => (typeof pr.lstat === 'function' ? pr.lstat(p) : pr.stat(p)),
    (raw) => new UringStats(raw),
    lstat
  );
}

async function access(filePath, modeOrOptions, options) {
  let mode = F_OK;
  let opts = options;

  if (typeof modeOrOptions === 'number') {
    mode = modeOrOptions;
  } else if (modeOrOptions && typeof modeOrOptions === 'object') {
    opts = modeOrOptions;
    if (modeOrOptions.mode !== undefined) {
      mode = modeOrOptions.mode;
    }
  } else if (modeOrOptions !== undefined) {
    const err = new TypeError(`The "mode" argument must be of type number. Received ${typeof modeOrOptions}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }

  if (typeof mode !== 'number' || !Number.isSafeInteger(mode) || mode < 0 || mode > 7) {
    const err = new RangeError(`The value of "mode" is out of range. It must be an integer >= 0 && <= 7. Received ${mode}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }

  const signal = opts && opts.signal;
  const normalized = normalizePath(filePath);

  await executeBackendOp({
    options: opts,
    signal,
    callerFn: access,
    onProvider: (provider) => {
      if (typeof provider.access === 'function') {
        return provider.access(normalized, mode);
      }
      return provider.stat(normalized).then(() => undefined);
    },
    onWorker: (pool) => pool.exec('access', [normalized, mode]),
    onNative: (native) => native.access(normalized, mode),
  });
}

async function exists(filePath, options) {
  try {
    await access(filePath, F_OK, options);
    return true;
  } catch (err) {
    if (
      err instanceof TypeError ||
      (err && (err.code === 'ABORT_ERR' || err.code === 'ERR_URING_UNSUPPORTED' || err.code === 'ERR_INVALID_ARG_TYPE'))
    ) {
      throw err;
    }
    return false;
  }
}

async function unlink(filePath, options) {
  return await dispatchSimpleMetaOp(
    'unlink',
    filePath,
    options,
    (n, p) => n.unlink(p),
    (p) => [p],
    (pr, p) => pr.unlink(p),
    null,
    unlink
  );
}

async function rmdir(dirPath, options) {
  let safeOpts = undefined;
  if (options && typeof options === 'object') {
    safeOpts = {};
    if (options.maxRetries !== undefined) safeOpts.maxRetries = options.maxRetries;
    if (options.retryDelay !== undefined) safeOpts.retryDelay = options.retryDelay;
  }
  return await dispatchSimpleMetaOp(
    'rmdir',
    dirPath,
    options,
    (n, p) => n.rmdir(p),
    (p) => (safeOpts ? [p, safeOpts] : [p]),
    (pr, p) => (typeof pr.rmdir === 'function' ? pr.rmdir(p, safeOpts) : fsPromises.rmdir(p, safeOpts)),
    null,
    rmdir
  );
}

async function mkdirRecursiveNative(native, resolved, mode, options) {
  const checkExistingDir = async (eexistErr) => {
    const st = await stat(resolved, options);
    if (st.isDirectory()) return true;
    throw eexistErr;
  };

  try {
    await native.mkdir(resolved, mode);
    return resolved;
  } catch (err) {
    if (err.code === 'EEXIST') {
      await checkExistingDir(err);
      return undefined;
    }
    if (err.code === 'ENOENT') {
      const parent = pathModule.dirname(resolved);
      if (parent !== resolved) {
        const firstCreated = await mkdir(parent, { ...(typeof options === 'object' ? options : {}), recursive: true, mode });
        try {
          await native.mkdir(resolved, mode);
          return firstCreated ?? resolved;
        } catch (e2) {
          if (e2.code === 'EEXIST') {
            await checkExistingDir(e2);
            return firstCreated;
          }
          throw e2;
        }
      }
    }
    throw err;
  }
}

async function mkdir(dirPath, options) {
  let mode = 0o777;
  let recursive = false;
  let signal = undefined;

  if (typeof options === 'number') {
    mode = options;
  } else if (options && typeof options === 'object') {
    if (options.mode !== undefined) mode = options.mode;
    if (options.recursive !== undefined) recursive = Boolean(options.recursive);
    signal = options.signal;
  }

  const normalized = normalizePath(dirPath);
  const opts = typeof options === 'object' ? options : undefined;

  return await executeBackendOp({
    options: opts,
    signal,
    callerFn: mkdir,
    onProvider: (provider) => provider.mkdir(normalized, { recursive, mode }),
    onWorker: (pool) => pool.exec('mkdir', [normalized, { recursive, mode }]),
    onNative: async (native) => {
      if (!recursive) {
        await native.mkdir(normalized, mode);
        return undefined;
      }
      return await mkdirRecursiveNative(native, pathModule.resolve(normalized), mode, options);
    },
  });
}

async function rename(oldPath, newPath, options) {
  return await dispatchSimpleMetaOp(
    'rename',
    [oldPath, newPath],
    options,
    (n, [o, d]) => n.rename(o, d),
    ([o, d]) => [o, d],
    (pr, [o, d]) => pr.rename(o, d),
    null,
    rename
  );
}

async function symlink(target, linkPath, typeOrOptions, optionsArg) {
  const type = typeof typeOrOptions === 'string'
    ? typeOrOptions
    : (typeOrOptions && typeof typeOrOptions === 'object' && typeof typeOrOptions.type === 'string' ? typeOrOptions.type : undefined);
  const options = typeof optionsArg === 'object' && optionsArg !== null
    ? optionsArg
    : (typeof typeOrOptions === 'object' && typeOrOptions !== null ? typeOrOptions : undefined);

  return await dispatchSimpleMetaOp(
    'symlink',
    [target, linkPath],
    options,
    (n, [t, l]) => n.symlink(t, l),
    ([t, l]) => [t, l, type],
    (pr, [t, l]) => pr.symlink(t, l, type),
    null,
    symlink
  );
}

async function link(existingPath, newPath, options) {
  return await dispatchSimpleMetaOp(
    'link',
    [existingPath, newPath],
    options,
    (n, [e, d]) => n.link(e, d),
    ([e, d]) => [e, d],
    (pr, [e, d]) => pr.link(e, d),
    null,
    link
  );
}

async function syncFile(filePath, datasyncOnly, options, callerFn) {
  return await dispatchSimpleMetaOp(
    'fsync',
    filePath,
    options,
    (n, p) => n.fsync(p, datasyncOnly),
    (p) => [p, datasyncOnly],
    (pr, p, signal) => {
      const method = datasyncOnly ? 'fdatasync' : 'fsync';
      if (typeof pr[method] === 'function') {
        return pr[method](p);
      }
      return withProviderHandle(pr, p, 'r', undefined, signal, method, (fh) =>
        datasyncOnly ? fh.datasync() : fh.sync()
      );
    },
    null,
    callerFn
  );
}

async function fsync(filePath, options) {
  return await syncFile(filePath, false, options, fsync);
}

async function fdatasync(filePath, options) {
  return await syncFile(filePath, true, options, fdatasync);
}

module.exports = {
  stat,
  lstat,
  access,
  exists,
  unlink,
  rmdir,
  mkdir,
  rename,
  symlink,
  link,
  fsync,
  fdatasync,
};
