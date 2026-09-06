// Worktree isolation. Agents cannot collide in a directory they do not share.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);

export function createWorktrees({ repo, root }) {
  return {
    async create(agentId) {
      const path = join(root, agentId);
      const branch = `minimac/${agentId}`;
      try {
        await run('git', ['worktree', 'add', '-B', branch, path], { cwd: repo });
      } catch (error) {
        if (!String(error.stderr ?? '').includes('already exists')) throw error;
      }
      return path;
    },

    async remove(agentId) {
      const path = join(root, agentId);
      await run('git', ['worktree', 'remove', '--force', path], { cwd: repo }).catch(() => {});
    },

    async list() {
      const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
      return stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
    },
  };
}
