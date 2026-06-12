import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const SECURITY_OVERRIDES = {
  '@protobufjs/utf8': '1.1.1',
  axios: '1.17.0',
  picomatch: '4.0.4',
  postcss: '8.5.15',
  protobufjs: '7.5.8',
  qs: '6.15.2',
  vite: '7.3.5',
  ws: '8.21.0',
};

describe('GitHub release workflow', () => {
  it('installs dependencies from the pnpm lockfile', async () => {
    const workflow = await fs.readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('corepack enable');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).not.toContain('npm install --no-package-lock');
  });

  it('passes dispatch tag input through environment variables before shell use', async () => {
    const workflow = await fs.readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('INPUT_TAG: ${{ inputs.tag }}');
    expect(workflow).toContain('TAG: ${{ steps.ref.outputs.tag }}');
    expect(workflow).not.toContain("TAG='${{ steps.ref.outputs.tag }}'");
    expect(workflow).not.toContain('python3 - <<\'PY\' "${{ steps.ref.outputs.tag }}"');
  });
});

describe('package security overrides', () => {
  it('keeps npm and pnpm installs on the same patched transitive dependency set', async () => {
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
      packageManager?: string;
      overrides?: Record<string, string>;
      pnpm?: { overrides?: Record<string, string> };
    };

    expect(pkg.packageManager).toMatch(/^pnpm@/);
    expect(pkg.overrides).toMatchObject(SECURITY_OVERRIDES);
    expect(pkg.pnpm?.overrides).toMatchObject(SECURITY_OVERRIDES);
  });
});
