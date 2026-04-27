// GH#7: Typed metadata vocabulary for traceable iSDLC artifact chunks.
//
// The vocabulary lives in chunk metadata and is carried through to vector DB
// metadata. Population is owned by future source connectors; this module only
// defines the contract, validates custom linked_* extensions, and extracts
// well-formed fields for persistence.

export const ARTIFACT_TYPES = Object.freeze([
  'requirement',
  'fr',
  'ac',
  'nfr',
  'adr',
  'module',
  'test_case',
  'task',
  'review',
  'risk',
  'feature',
  'convention',
  'code',
  'bug_report',
  'trace_analysis',
]);

export const TRACEABILITY_STRING_FIELDS = Object.freeze([
  'artifact_type',
  'artifact_id',
  'motivated_by',
  'provenance',
]);

export const TRACEABILITY_LINK_FIELDS = Object.freeze([
  'linked_fr',
  'linked_ac',
  'linked_adr',
  'linked_module',
  'linked_test_case',
  'linked_task',
  'linked_review',
  'linked_risk',
  'linked_nfr',
  'linked_feature',
  'linked_bug_fix',
]);

export const TRACEABILITY_NUMERIC_FIELDS = Object.freeze([
  'link_confidence',
]);

export const TRACEABILITY_METADATA_FIELDS = Object.freeze([
  ...TRACEABILITY_STRING_FIELDS,
  ...TRACEABILITY_LINK_FIELDS,
  ...TRACEABILITY_NUMERIC_FIELDS,
]);

const CUSTOM_LINK_FIELD_PATTERN = /^linked_[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const BUILTIN_LINK_FIELDS = new Set(TRACEABILITY_LINK_FIELDS);

/**
 * @typedef {object} MetadataVocabularyConfig
 * @property {string[]} [custom_link_fields] Project-specific linked_* fields.
 */

/**
 * @typedef {object} TraceabilityMetadata
 * @property {string} [artifact_type]
 * @property {string} [artifact_id]
 * @property {string[]} [linked_fr]
 * @property {string[]} [linked_ac]
 * @property {string[]} [linked_adr]
 * @property {string[]} [linked_module]
 * @property {string[]} [linked_test_case]
 * @property {string[]} [linked_task]
 * @property {string[]} [linked_review]
 * @property {string[]} [linked_risk]
 * @property {string[]} [linked_nfr]
 * @property {string[]} [linked_feature]
 * @property {string[]} [linked_bug_fix]
 * @property {string} [motivated_by]
 * @property {string} [provenance]
 * @property {number} [link_confidence]
 */

/**
 * Return validation errors for the optional project-level metadata vocabulary.
 *
 * Expected shape:
 *   { metadata_vocabulary: { custom_link_fields: ["linked_compliance_check"] } }
 *
 * @param {object} config
 * @returns {string[]}
 */
export function validateMetadataVocabularyConfig(config = {}) {
  const vocabulary = config?.metadata_vocabulary;
  if (vocabulary === undefined) return [];

  if (vocabulary === null || typeof vocabulary !== 'object' || Array.isArray(vocabulary)) {
    return ['metadata_vocabulary must be an object'];
  }

  const fields = vocabulary.custom_link_fields;
  if (fields === undefined || fields === null) return [];
  if (!Array.isArray(fields)) {
    return ['metadata_vocabulary.custom_link_fields must be an array of strings'];
  }

  const errors = [];
  const seen = new Set();
  fields.forEach((field, index) => {
    const label = `metadata_vocabulary.custom_link_fields[${index}]`;
    if (typeof field !== 'string' || field.length === 0) {
      errors.push(`${label} must be a non-empty string`);
      return;
    }
    if (!CUSTOM_LINK_FIELD_PATTERN.test(field)) {
      errors.push(`${label} must use lowercase snake_case and start with linked_`);
      return;
    }
    if (BUILTIN_LINK_FIELDS.has(field)) {
      errors.push(`${label} must not redeclare built-in field ${field}`);
      return;
    }
    if (seen.has(field)) {
      errors.push(`${label} duplicates ${field}`);
      return;
    }
    seen.add(field);
  });

  return errors;
}

/**
 * Resolve the custom linked_* fields declared by a project config vocabulary.
 *
 * @param {MetadataVocabularyConfig | undefined | null} vocabulary
 * @returns {string[]}
 */
export function customLinkFields(vocabulary = {}) {
  const errors = validateMetadataVocabularyConfig({ metadata_vocabulary: vocabulary });
  if (errors.length > 0) {
    throw new TypeError(errors.join('; '));
  }
  if (!vocabulary || !Array.isArray(vocabulary.custom_link_fields)) return [];
  return [...new Set(vocabulary.custom_link_fields)];
}

/**
 * Extract well-formed traceability metadata from a connector-supplied metadata
 * bag. Invalid values are ignored so a malformed source chunk does not poison
 * the vector index.
 *
 * @param {object | undefined | null} metadata
 * @param {MetadataVocabularyConfig | undefined | null} [vocabulary]
 * @returns {Record<string, string | string[] | number>}
 */
export function extractTraceabilityMetadata(metadata, vocabulary = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  const out = {};

  for (const field of TRACEABILITY_STRING_FIELDS) {
    const value = metadata[field];
    if (typeof value === 'string' && value.length > 0) {
      out[field] = value;
    }
  }

  for (const field of [...TRACEABILITY_LINK_FIELDS, ...customLinkFields(vocabulary)]) {
    const value = metadata[field];
    if (!Array.isArray(value)) continue;
    out[field] = value.filter((item) => typeof item === 'string' && item.length > 0);
  }

  const confidence = metadata.link_confidence;
  if (
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
  ) {
    out.link_confidence = confidence;
  }

  return out;
}
