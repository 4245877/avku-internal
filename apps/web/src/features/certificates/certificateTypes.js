export const EMPTY_CROP = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

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
 * @property {string} photoUrl
 * @property {string} photoDataUrl
 * @property {File|null} photoFile
 * @property {CertificatePhotoCrop} photoCrop
 * @property {string} createdAt
 * @property {string} updatedAt
 */
