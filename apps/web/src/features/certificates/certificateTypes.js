export const MIN_ZOOM = 1;
export const MAX_ZOOM = 10;
export const MIN_ROTATION = -180;
export const MAX_ROTATION = 180;

/**
 * Zoom that puts a head-and-shoulders portrait inside the face guide oval.
 * Used by the «Під овал» preset — there is no face detection, so this is a
 * standard ID-photo framing the operator then nudges into place.
 */
export const FACE_PRESET_ZOOM = 1.35;

export const EMPTY_CROP = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
};

/**
 * Width requested for on-screen photo previews. The photo frame is 377px wide
 * in template space, so this leaves room to zoom in without shipping the
 * multi-megabyte original; exports still render from the stored file.
 */
export const PHOTO_PREVIEW_WIDTH = 1200;

export const DEFAULT_CERTIFICATE_TEMPLATE_ID = 'volunteer-card-v1-uk';
export const LEGACY_CERTIFICATE_TEMPLATE_ID = 'volunteer-card-v1';

/**
 * @typedef {Object} CertificatePhotoCrop
 * @property {number} zoom
 * @property {number} offsetX
 * @property {number} offsetY
 * @property {number} rotation Clockwise degrees, normalised to (-180, 180].
 */

/**
 * @typedef {Object} CertificateRecord
 * @property {string} id
 * @property {string} fullName
 * @property {string} firstNameEn
 * @property {string} lastNameEn
 * @property {string} fullNameEn
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
 * @property {string} firstNameEn
 * @property {string} lastNameEn
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
