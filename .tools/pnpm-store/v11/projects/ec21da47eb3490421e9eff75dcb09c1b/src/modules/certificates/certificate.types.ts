export type CertificateTextAlign =
  | "left"
  | "center"
  | "centre"
  | "right";

export interface CertificateCanvasLayout {
  width: number;
  height: number;
}

export interface CertificatePhotoLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  bleed?: number;
}

export interface CertificateImageOverlayLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CertificateTextFieldLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  font: string;
  fontSize: number;
  minFontSize?: number;
  widthFactor?: number;
  align?: CertificateTextAlign;
}

export interface CertificateLayout {
  id: string;

  canvas: CertificateCanvasLayout;

  photo: CertificatePhotoLayout;

  stampOverlay?: CertificateImageOverlayLayout;

  fields: {
    lastName: CertificateTextFieldLayout;
    fullName: CertificateTextFieldLayout;
    certificateNumber: CertificateTextFieldLayout;
    issuedAt?: CertificateTextFieldLayout;
    validUntil: CertificateTextFieldLayout;
  };
}

export interface CertificatePhotoCrop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface RenderCertificateInput {
  templateDirectory: string;
  outputPath: string;
  photoPath: string;
  photoCrop?: Partial<CertificatePhotoCrop>;

  lastName: string;
  firstName: string;
  middleName?: string;

  certificateNumber: string;
  issuedAt?: string;

  /**
   * Допустимые варианты:
   * 2027-12-31
   * 31.12.2027
   */
  validUntil: string;
}
