// Only the owned service process has this IPC channel. No renderer API exposes it.
exports.installCredentialBridge = (child, safeStorage, platform = process.platform) => {
  const listener = async (request) => {
    if (request?.type !== 'credential-protect') return;
    const reply = { type: 'credential-protect-result', id: request.id };
    try {
      if (typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/.test(request.id) ||
          !['encrypt', 'decrypt'].includes(request.operation) ||
          typeof request.value !== 'string' || request.value.length > 131072) {
        throw new Error('Invalid credential request.');
      }
      if (!safeStorage.isEncryptionAvailable() ||
          (platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))) {
        throw new Error('Unlock your system keyring, or configure an environment credential in advanced settings.');
      }
      if (request.operation === 'encrypt') {
        reply.value = safeStorage.encryptString(request.value).toString('base64');
      } else {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(request.value)) throw new Error('Invalid encrypted credential.');
        reply.value = safeStorage.decryptString(Buffer.from(request.value, 'base64'));
      }
    } catch (error) {
      reply.error = error.message === 'Unlock your system keyring, or configure an environment credential in advanced settings.'
        ? error.message : 'The system credential store could not complete the request.';
    }
    if (child.connected) child.send(reply, () => {});
  };
  child.on('message', listener);
  child.once('exit', () => child.off('message', listener));
};
