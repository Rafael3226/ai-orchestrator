import { ulid } from 'ulid';

export type TaskId = string & { readonly __brand: 'TaskId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };

export const newTaskId = (): TaskId => `task_${ulid()}` as TaskId;
export const newRunId = (): RunId => `run_${ulid()}` as RunId;
export const newWorkspaceId = (): WorkspaceId => `ws_${ulid()}` as WorkspaceId;

/** Last 4 chars of a ulid — enough to disambiguate a directory name. */
export const shortId = (id: string): string => id.slice(-4).toLowerCase();
