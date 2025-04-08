const jose = {
  compactDecrypt: jest.fn(),
  compactEncrypt: jest.fn(),
  JWEHeaderParameters: jest.fn(),
  JWTClaimsSet: jest.fn(),
  JWK: jest.fn(),
  JWKS: jest.fn(),
  KeyLike: jest.fn(),
  FlattenedEncrypt: jest.fn(),
  FlattenedDecrypt: jest.fn(),
  GeneralEncrypt: jest.fn(),
  GeneralDecrypt: jest.fn(),
  UnsecuredJWT: jest.fn(),
  errors: {
    JWEInvalid: jest.fn(),
    JWEDecryptionFailed: jest.fn(),
    JWTInvalid: jest.fn(),
    JWTExpired: jest.fn(),
    JWTSignatureVerificationFailed: jest.fn(),
  },
  // Add any other exports from 'jose' that your code might be using
};

module.exports = jose;
