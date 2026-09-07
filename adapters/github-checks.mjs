import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT']);

function parse(stdout) {
  const checks = JSON.parse(String(stdout || '[]'));
  if (!Array.isArray(checks)) throw new Error('GitHub returned an invalid check list');
  return checks;
}

export function createGithubChecksPort({ repo }) {
  return {
    async failuresFor(number) {
      try {
        const { stdout } = await execute('gh', [
          'pr', 'checks', String(number), '--json', 'name,state,bucket,link',
        ], { cwd: repo, timeout: 20_000, maxBuffer: 1_000_000 });
        return parse(stdout).filter((check) => check.bucket === 'fail' || FAILED.has(check.state));
      } catch (error) {
        // `gh pr checks` exits non-zero when checks fail, while still returning
        // valid JSON. Only that case is data; all other failures stay failures.
        if (error?.stdout) {
          try {
            return parse(error.stdout).filter((check) => check.bucket === 'fail' || FAILED.has(check.state));
          } catch {
            // Fall through to the boundary error below.
          }
        }
        throw new Error(String(error?.stderr || error?.message || 'GitHub checks are unavailable').trim());
      }
    },
  };
}
