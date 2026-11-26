import { conflict } from "../errors.js";

export type FileWrite = { path: string; before: string | null; after: string };
export type FileWriteProgress = { appliedPaths: string[]; preparedPath?: string; recoveredPaths?: string[] };

export function hasUnsettledPublication(publication: (FileWriteProgress & { state: string }) | null | undefined) {
  return !!publication && publication.state !== "published" && publication.state !== "kept_current" &&
    !!(publication.preparedPath || publication.appliedPaths.length);
}

export function canKeepCurrentPublication(publication: (FileWriteProgress & { state: string; plan?: unknown }) | null | undefined) {
  return !!publication?.plan && publication.state === "conflict" && hasUnsettledPublication(publication);
}

export function unfinishedPublicationError(subject: string, state: string) {
  return conflict("publication_unsettled", `${subject} has an unfinished file publication. ` +
    (state === "conflict" ? "Review the current files in its work thread before starting new work in this directory." :
      "Resume the original publication before replacing this work or copying its project files."));
}

export function applyFileWriteSet<T extends { path: string; before: string | null; after: string | null }>(
  files: T[],
  progress: FileWriteProgress,
  options: {
    checkRoot: () => void;
    readHash: (path: string) => string | null;
    write: (file: T) => void;
    save: () => void;
    allowConvergence?: boolean;
    conflictCode?: string;
  },
) {
  const changed = (file: T) => conflict(options.conflictCode ?? "file_changed", `The project version changed for ${file.path}.`);
  options.checkRoot();
  const checked = files.map(file => {
    const actual = options.readHash(file.path);
    const applied = progress.appliedPaths.includes(file.path);
    const prepared = progress.preparedPath === file.path;
    if (applied ? actual !== file.after :
      actual !== file.before && !((options.allowConvergence || prepared) && actual === file.after))
      throw changed(file);
    return { file, actual, applied, prepared };
  });
  for (const { file, actual, applied, prepared } of checked) {
    if (applied) continue;
    options.checkRoot();
    if (prepared && actual === file.after && file.before !== file.after)
      (progress.recoveredPaths ??= []).push(file.path);
    if (actual !== file.after) {
      progress.preparedPath = file.path;
      options.save();
      options.write(file);
    }
    progress.appliedPaths.push(file.path);
    delete progress.preparedPath;
    options.save();
  }
  options.checkRoot();
  for (const file of files) if (options.readHash(file.path) !== file.after) throw changed(file);
}
