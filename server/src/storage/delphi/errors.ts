/**
 * Delphi Storage V2 error classes. The `code` values are the cross-language
 * error names used by the conformance cases
 * (delphi/delphi_storage/conformance/README.md): already_exists, not_found,
 * invalid.
 */
export class StorageError extends Error {
  code = "storage_error";

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AlreadyExistsError extends StorageError {
  code = "already_exists";
}

export class NotFoundError extends StorageError {
  code = "not_found";
}

export class InvalidError extends StorageError {
  code = "invalid";
}
