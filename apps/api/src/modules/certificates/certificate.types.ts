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
}

export interface CertificateTextFieldLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  font: string;
  fontSize: number;
  align?: CertificateTextAlign;
}

export interface CertificateLayout {
  id: string;

  canvas: CertificateCanvasLayout;

  photo: CertificatePhotoLayout;

  fields: {
    lastName: CertificateTextFieldLayout;
    fullName: CertificateTextFieldLayout;
    certificateNumber: CertificateTextFieldLayout;
    validUntil: CertificateTextFieldLayout;
  };
}

export interface RenderCertificateInput {
  templateDirectory: string;
  outputPath: string;
  photoPath: string;

  lastName: string;
  firstName: string;
  middleName?: string;

  certificateNumber: string;

  /**
   * Допустимые варианты:
   * 2027-12-31
   * 31.12.2027
   */
  validUntil: string;
}