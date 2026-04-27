// REQ-GH-7 deployment-wide vocabulary layer — unit tests for the deployment
// validator and the merge function.
//
// Trace:
//   FR-001 / AC-001-01..05 — validateDeploymentVocabulary
//   FR-004 / AC-004-01..04 — mergeVocabularies
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeVocabularies,
  validateDeploymentVocabulary,
} from '../../../src/pipeline/metadata-vocabulary.js';

/* ------------------------------------------------------------------ */
/* validateDeploymentVocabulary                                       */
/* ------------------------------------------------------------------ */

test('validateDeploymentVocabulary accepts a valid custom_link_fields list (AC-001-01)', () => {
  const errors = validateDeploymentVocabulary({
    metadata_vocabulary: {
      custom_link_fields: ['linked_jira_epic', 'linked_compliance_check'],
    },
  });
  assert.deepEqual(errors, []);
});

test('validateDeploymentVocabulary accepts absent metadata_vocabulary block (AC-001-02)', () => {
  // No metadata_vocabulary key at all — empty deployment list.
  assert.deepEqual(validateDeploymentVocabulary({}), []);
  // Empty config object.
  assert.deepEqual(validateDeploymentVocabulary({ server: {} }), []);
});

test('validateDeploymentVocabulary accepts empty custom_link_fields array', () => {
  assert.deepEqual(
    validateDeploymentVocabulary({ metadata_vocabulary: { custom_link_fields: [] } }),
    [],
  );
});

test('validateDeploymentVocabulary rejects non-snake_case / missing prefix (AC-001-03)', () => {
  const errors = validateDeploymentVocabulary({
    metadata_vocabulary: {
      custom_link_fields: ['linked_FR', 'compliance_check', 'Linked_camel'],
    },
  });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /lowercase snake_case/);
  assert.match(errors[1], /start with linked_/);
  assert.match(errors[2], /lowercase snake_case/);
});

test('validateDeploymentVocabulary rejects redeclaration of built-in linked_* (AC-001-04)', () => {
  const errors = validateDeploymentVocabulary({
    metadata_vocabulary: { custom_link_fields: ['linked_fr', 'linked_test_case'] },
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /built-in field linked_fr/);
  assert.match(errors[1], /built-in field linked_test_case/);
});

test('validateDeploymentVocabulary rejects in-list duplicates (AC-001-05)', () => {
  const errors = validateDeploymentVocabulary({
    metadata_vocabulary: {
      custom_link_fields: ['linked_squad', 'linked_squad'],
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicates linked_squad/);
});

test('validateDeploymentVocabulary rejects null / non-object metadata_vocabulary', () => {
  assert.deepEqual(
    validateDeploymentVocabulary({ metadata_vocabulary: null }),
    ['metadata_vocabulary must be an object'],
  );
  assert.deepEqual(
    validateDeploymentVocabulary({ metadata_vocabulary: ['linked_x'] }),
    ['metadata_vocabulary must be an object'],
  );
});

test('validateDeploymentVocabulary rejects non-array custom_link_fields', () => {
  assert.deepEqual(
    validateDeploymentVocabulary({
      metadata_vocabulary: { custom_link_fields: 'linked_squad' },
    }),
    ['metadata_vocabulary.custom_link_fields must be an array of strings'],
  );
});

/* ------------------------------------------------------------------ */
/* mergeVocabularies                                                  */
/* ------------------------------------------------------------------ */

test('mergeVocabularies returns the union of deployment + project fields (AC-004-01)', () => {
  const deployment = { custom_link_fields: ['linked_jira_epic'] };
  const project = { custom_link_fields: ['linked_squad'] };
  const merged = mergeVocabularies(deployment, project);
  assert.deepEqual(merged, { custom_link_fields: ['linked_jira_epic', 'linked_squad'] });
});

test('mergeVocabularies de-duplicates overlapping entries (AC-004-03)', () => {
  // The project store's overlap check should prevent this in practice, but
  // the merge MUST be defensive against drift.
  const merged = mergeVocabularies(
    { custom_link_fields: ['linked_jira_epic'] },
    { custom_link_fields: ['linked_jira_epic', 'linked_squad'] },
  );
  assert.deepEqual(merged.custom_link_fields, ['linked_jira_epic', 'linked_squad']);
});

test('mergeVocabularies handles undefined / null inputs (AC-004-02)', () => {
  assert.deepEqual(mergeVocabularies(undefined, undefined), { custom_link_fields: [] });
  assert.deepEqual(mergeVocabularies(null, null), { custom_link_fields: [] });
  assert.deepEqual(
    mergeVocabularies(null, { custom_link_fields: ['linked_x'] }),
    { custom_link_fields: ['linked_x'] },
  );
  assert.deepEqual(
    mergeVocabularies({ custom_link_fields: ['linked_y'] }, undefined),
    { custom_link_fields: ['linked_y'] },
  );
});

test('mergeVocabularies treats non-array custom_link_fields as empty', () => {
  // Defensive: don't throw if upstream passes a malformed shape.
  assert.deepEqual(
    mergeVocabularies({ custom_link_fields: 'not-an-array' }, undefined),
    { custom_link_fields: [] },
  );
});

test('mergeVocabularies does not mutate either input array (AC-004-04)', () => {
  const deployment = { custom_link_fields: ['linked_jira_epic'] };
  const project = { custom_link_fields: ['linked_squad'] };
  const deploymentSnapshot = [...deployment.custom_link_fields];
  const projectSnapshot = [...project.custom_link_fields];

  const merged = mergeVocabularies(deployment, project);
  // Mutate the merged result and verify inputs are untouched.
  merged.custom_link_fields.push('linked_extra');

  assert.deepEqual(deployment.custom_link_fields, deploymentSnapshot);
  assert.deepEqual(project.custom_link_fields, projectSnapshot);
});
