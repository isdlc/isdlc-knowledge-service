import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_TYPES,
  TRACEABILITY_METADATA_FIELDS,
  customLinkFields,
  extractTraceabilityMetadata,
  validateMetadataVocabularyConfig,
} from '../../../src/pipeline/metadata-vocabulary.js';

test('metadata vocabulary exports the built-in GH#7 artifact and metadata fields', () => {
  assert.ok(ARTIFACT_TYPES.includes('fr'));
  assert.ok(ARTIFACT_TYPES.includes('trace_analysis'));
  assert.ok(TRACEABILITY_METADATA_FIELDS.includes('artifact_type'));
  assert.ok(TRACEABILITY_METADATA_FIELDS.includes('linked_test_case'));
  assert.ok(TRACEABILITY_METADATA_FIELDS.includes('link_confidence'));
});

test('validateMetadataVocabularyConfig accepts custom linked_* fields', () => {
  const errors = validateMetadataVocabularyConfig({
    metadata_vocabulary: {
      custom_link_fields: ['linked_compliance_check', 'linked_control_id'],
    },
  });
  assert.deepEqual(errors, []);
});

test('validateMetadataVocabularyConfig rejects null metadata_vocabulary', () => {
  const errors = validateMetadataVocabularyConfig({ metadata_vocabulary: null });
  assert.deepEqual(errors, ['metadata_vocabulary must be an object']);
});

test('validateMetadataVocabularyConfig rejects invalid custom linked_* declarations', () => {
  const errors = validateMetadataVocabularyConfig({
    metadata_vocabulary: {
      custom_link_fields: [
        'compliance_check',
        'linked_Compliance',
        'linked_fr',
        'linked_control',
        'linked_control',
      ],
    },
  });
  assert.equal(errors.length, 4);
  assert.match(errors[0], /start with linked_/);
  assert.match(errors[1], /lowercase snake_case/);
  assert.match(errors[2], /built-in field linked_fr/);
  assert.match(errors[3], /duplicates linked_control/);
});

test('customLinkFields returns configured fields', () => {
  assert.deepEqual(
    customLinkFields({ custom_link_fields: ['linked_policy', 'linked_control'] }),
    ['linked_policy', 'linked_control'],
  );
});

test('extractTraceabilityMetadata keeps valid built-in and declared custom fields only', () => {
  const out = extractTraceabilityMetadata(
    {
      artifact_type: 'fr',
      artifact_id: 'FR-007',
      linked_ac: ['AC-007-01', '', 42],
      linked_policy: ['POL-9'],
      linked_unregistered: ['X-1'],
      motivated_by: 'REQ-GH-263',
      provenance: 'docs/requirements/requirements-spec.md:12',
      link_confidence: 1,
      random: 'ignore me',
    },
    { custom_link_fields: ['linked_policy'] },
  );

  assert.deepEqual(out, {
    artifact_type: 'fr',
    artifact_id: 'FR-007',
    linked_ac: ['AC-007-01'],
    linked_policy: ['POL-9'],
    motivated_by: 'REQ-GH-263',
    provenance: 'docs/requirements/requirements-spec.md:12',
    link_confidence: 1,
  });
});

test('extractTraceabilityMetadata ignores invalid confidence and non-array links', () => {
  const out = extractTraceabilityMetadata({
    artifact_type: 'task',
    linked_fr: 'FR-001',
    link_confidence: 1.5,
  });
  assert.deepEqual(out, { artifact_type: 'task' });
});
