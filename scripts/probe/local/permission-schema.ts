/**
 * Contract probe for the permission payload schemas (C-04).
 *
 * Covers the shapes the dashboard client actually emits, plus the ones an
 * external caller plausibly emits, so a future strictness change has to declare
 * which of them it is breaking.
 */
import {
  adminUpdatePermissionSchema,
  createPermissionSchema,
  pagePermissionSchema,
} from '@/utils/validation/permissions';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- module-scope tally: the check() helper is its only writer and the exit code at the end of the file is its only reader
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`
  );
}

function page(input: unknown) {
  const r = pagePermissionSchema.safeParse(input);
  return r.success
    ? { ok: true as const, data: r.data }
    : { ok: false as const, msg: r.error.issues[0]?.message ?? '' };
}

// ── what the current UI sends: only the page's own available actions ──
const uiHome = page({ name: 'home', permissions: { view: true } });
check('UI home matrix accepted', uiHome.ok, JSON.stringify(uiHome));

const uiUsers = page({
  name: 'users',
  permissions: {
    view: true,
    viewOwn: false,
    edit: true,
    editOwn: false,
    delete: false,
    deleteOwn: false,
    create: true,
  },
});
check('UI users matrix accepted', uiUsers.ok, JSON.stringify(uiUsers));

// ── uniform full matrix from an external caller ────────────────────────
const uniform = page({
  name: 'home',
  permissions: { view: true, edit: false, delete: false, create: false },
});
check('unavailable actions set false are normalized away', uniform.ok);
check(
  'normalized matrix keeps only available actions',
  uniform.ok && JSON.stringify(uniform.data.permissions) === '{"view":true}',
  uniform.ok ? JSON.stringify(uniform.data.permissions) : ''
);

// ── granting something the page cannot express is still refused ────────
const granted = page({ name: 'home', permissions: { view: true, edit: true } });
check(
  'unavailable action set TRUE is rejected',
  !granted.ok,
  granted.ok ? '' : granted.msg
);

// ── unknown/misspelled keys are still refused ──────────────────────────
const typo = page({ name: 'home', permissions: { view: true, dleete: true } });
check('misspelled action rejected', !typo.ok);
const typoFalse = page({
  name: 'home',
  permissions: { view: true, dleete: false },
});
check('misspelled action rejected even when false', !typoFalse.ok);

// ── structural guards unchanged ────────────────────────────────────────
check(
  'null permissions rejected',
  !page({ name: 'home', permissions: null }).ok
);
check('missing permissions rejected', !page({ name: 'home' }).ok);
check('unknown page rejected', !page({ name: 'nope', permissions: {} }).ok);
check(
  'extra top-level key rejected',
  !page({ name: 'home', permissions: { view: true }, extra: 1 }).ok
);
check(
  'write without view rejected',
  !page({ name: 'users', permissions: { edit: true, view: false } }).ok
);
check(
  'editOwn with viewOwn accepted',
  page({ name: 'users', permissions: { editOwn: true, viewOwn: true } }).ok
);
check(
  'create alone accepted (no view needed)',
  page({ name: 'users', permissions: { create: true } }).ok
);

// ── collection contracts ───────────────────────────────────────────────
const clientCreatePayload = {
  roleName: 'محرر',
  description: 'وصف',
  isActive: true,
  permissions: [
    { name: 'home', permissions: { view: true } },
    {
      name: 'users',
      permissions: {
        view: true,
        viewOwn: false,
        edit: false,
        editOwn: false,
        delete: false,
        deleteOwn: false,
        create: false,
      },
    },
  ],
};

check(
  'collection POST accepts the real client payload',
  createPermissionSchema.safeParse(clientCreatePayload).success,
  JSON.stringify(
    createPermissionSchema.safeParse(clientCreatePayload).error?.issues?.[0]
  )
);

// The collection POST is deliberately lenient on unknown TOP-LEVEL keys, so a
// caller may post back a response object and have the server-owned fields
// dropped. Asserting they are STRIPPED, not merely accepted.
const withServerOwned = createPermissionSchema.safeParse({
  ...clientCreatePayload,
  scope: 'standard',
  createdBy: '019702b8-6c2e-7000-8000-000000000000',
  createdAt: '2026-01-01',
  usersCount: 3,
});
check('collection POST accepts server-owned extras', withServerOwned.success);
check(
  'collection POST STRIPS them from the parsed output',
  withServerOwned.success &&
    ['scope', 'createdBy', 'createdAt', 'usersCount'].every(
      (k) => !(k in withServerOwned.data)
    ),
  withServerOwned.success ? Object.keys(withServerOwned.data).join(',') : ''
);
check(
  'collection POST still rejects a missing required field',
  !createPermissionSchema.safeParse({
    description: 'x',
    permissions: clientCreatePayload.permissions,
  }).success
);
check(
  'strict PUT accepts the real client payload',
  adminUpdatePermissionSchema.safeParse({
    id: '019702b8-6c2e-7000-8000-000000000000',
    roleName: 'محرر',
    description: 'وصف',
    isActive: true,
    permissions: clientCreatePayload.permissions,
  }).success
);
check(
  'strict PUT rejects a response-only field',
  !adminUpdatePermissionSchema.safeParse({
    id: '019702b8-6c2e-7000-8000-000000000000',
    roleName: 'محرر',
    isActive: true,
    usersCount: 3,
  }).success
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
// eslint-disable-next-line unicorn/no-process-exit -- CLI probe: the exit code is how it reports pass/fail, the case the rule excepts
process.exit(failures === 0 ? 0 : 1);
