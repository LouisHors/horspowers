// Session hooks and every migrated workflow now enter the shared runtime, so
// company-project code workflows may resume while documentation failures stay
// fail-closed inside that runtime.
export const EXTERNAL_DOCUMENT_RUNTIME_VERSION = 1;
