import legacy from './index.cjs';

export * from 'glob-upstream';
export { legacy as default, legacy as glob };
export const sync = legacy.sync;
