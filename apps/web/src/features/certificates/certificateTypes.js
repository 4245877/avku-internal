export const EMPTY_CROP = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

export const DEFAULT_CERTIFICATE_TEMPLATE_ID = 'volunteer-card-v1-uk';
export const LEGACY_CERTIFICATE_TEMPLATE_ID = 'volunteer-card-v1';

/**
 * @typedef {Object} CertificatePhotoCrop
 * @property {number} zoom
 * @property {number} offsetX
 * @property {number} offsetY
 */

/**
 * @typedef {Object} CertificateRecord
 * @property {string} id
 * @property {string} fullName
 * @property {string} certificateNumber
 * @property {string} issuedAt
 * @property {string} validUntil
 * @property {string} templateId
 * @property {string} photoUrl
 * @property {CertificatePhotoCrop} photoCrop
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} CertificateFormValue
 * @property {string} id
 * @property {string} fullName
 * @property {string} certificateNumber
 * @property {string} issuedAt
 * @property {string} validUntil
 * @property {string} templateId
 * @property {string} photoUrl
 * @property {string} photoDataUrl
 * @property {File|null} photoFile
 * @property {CertificatePhotoCrop} photoCrop
 * @property {string} createdAt
 * @property {string} updatedAt
 */
