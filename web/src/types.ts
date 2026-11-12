export interface CourseSummary {
  id: string;
  subject: string;
  number: string;
  title: string;
  units: string;
  excerpt: string;
}
export interface Course extends CourseSummary {
  description: string;
  term: string;
  prerequisite: string;
  corequisite: string;
  concurrent: string;
  recommended: string;
  geArea: string;
  gradingBasis: string;
  catalogDetails: string;
  campus: string;
  catalogEdition: string;
  sourceUrl: string;
  retrievedAt: string;
}
export interface Catalog {
  edition: string;
  retrievedAt: string;
  subjects: { code: string; label: string; count: number }[];
  courses: CourseSummary[];
}
export interface Row {
  id: string;
  version: number;
  [key: string]: unknown;
}
export interface Section extends Row {
  courseId: string;
  termId: string;
  sectionNumber: string;
  campus: string;
  instructor?: string;
  crn?: string;
  materialsUrl?: string;
  sourceRetrievedAt?: string;
  termLabel?: string;
}
export interface Book extends Row {
  title: string;
  author: string;
  edition: string;
  format: string;
  isbn?: string;
}
export interface Requirement extends Row {
  sectionId: string;
  bookId?: string;
  materialType: string;
  title: string;
  requirementLevel: string;
  verificationStatus: string;
  sourceUrl?: string;
  verifiedAt?: string;
  accessCodeRequired?: boolean;
  notes?: string;
}
export interface Offer extends Row {
  bookId: string;
  seller: string;
  url: string;
  price: number;
  currency: string;
  shippingPrice?: number;
  purchaseType: string;
  condition: string;
  rentalDays?: number;
  checkedAt: string;
  accessCodeIncluded?: boolean;
}
export type Collection =
  | "sections"
  | "books"
  | "material-requirements"
  | "offers";
