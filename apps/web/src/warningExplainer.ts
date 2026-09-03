/**
 * Plain-language explanations for the Sourcify clear-signing library's warning
 * codes, shown as a hover tooltip on the code chip. Codes follow the
 * `WarningCode` union in `@ethereum-sourcify/clear-signing`.
 */

const EXPLAIN: Record<string, string> = {
  UNEXPECTED_LIB_ERROR: "The library hit an internal error while rendering. Likely a bug in the library, not in the descriptor.",
  NO_DESCRIPTOR: "No ERC-7730 descriptor was found for this contract and chain.",
  DESCRIPTOR_FETCH_ERROR: "The descriptor could not be loaded from the registry.",
  INVALID_CALLDATA_HEX: "The calldata is not valid hex.",
  CALLDATA_TOO_SHORT: "The calldata is shorter than a 4-byte function selector.",
  UNSUPPORTED_DOMAIN: "The descriptor targets a kind of signing (for example EIP-712 typed data) that this call is not.",
  DEPLOYMENT_MISMATCH: "The descriptor exists, but it does not list this contract address on this chain.",
  NO_FORMAT_MATCH: "The descriptor covers the contract, but not this function selector. The wallet falls back to raw calldata.",
  CALLDATA_DECODE_ERROR: "The calldata could not be decoded with the descriptor's ABI. The arguments may not match the declared types.",
  MUSTMATCH_VIOLATION: "A value the descriptor requires to equal a fixed constant did not match.",
  UNSUPPORTED_NESTED_FIELD_GROUP: "The descriptor nests field groups deeper than the library supports.",
  DEFINITIONS_RESOLUTION_ERROR: "A `$ref` to the descriptor's shared definitions could not be resolved.",
  INVALID_DESCRIPTOR: "The descriptor does not follow the ERC-7730 schema.",
  INTERPOLATION_ERROR: "A field value could not be inserted into the intent text.",
  UNKNOWN_TOKEN: "The token's symbol and decimals could not be resolved, so the amount is shown as a raw integer.",
  UNKNOWN_ADDRESS: "No name (ENS or local) was found for this address, so the raw address is shown.",
  ADDRESS_TYPE_MISMATCH: "The address resolved to a name, but its kind (contract vs. wallet) is not one the descriptor allows.",
  CONTAINER_MISSING_CHAIN_ID: "The transaction carried no chain id, which this field's format needs.",
  CONTAINER_MISSING_REQUIRED_PATH: "A transaction property the descriptor references (for example the value or the sender) is missing.",
  ARGUMENT_TYPE_MISMATCH: "The decoded argument has a different type than the field's format expects.",
  DOMAIN_MISMATCH: "The EIP-712 domain of the message does not match the descriptor.",
  EMPTY_ARRAY: "An array argument was empty, so there is nothing to display for it.",
  UNKNOWN_NFT_COLLECTION: "The NFT collection's name could not be resolved, so the raw address is shown.",
  BUNDLED_ARRAY_SIZE_MISMATCH: "Arrays the descriptor pairs together have different lengths.",
  FORMAT_PARAM_RESOLUTION_ERROR: "A parameter the format needs (for example the token address) could not be read from the calldata.",
  UNKNOWN_ENCODING: "The descriptor uses an encoding the library does not know.",
  UNKNOWN_BLOCK: "The block height could not be turned into a timestamp.",
  UNKNOWN_CHAIN: "The chain's native currency could not be resolved, so the amount is shown in raw wei.",
  PARAM_ARRAY_SIZE_MISMATCH: "A parameter array in the descriptor has a different length than the values it applies to.",
  EMBEDDED_CALLDATA_NOT_SUPPORTED: "The call embeds another call that the library cannot render yet.",
  DECRYPTION_FAILED: "An encrypted field could not be decrypted, so its fallback label is shown.",
  BATCH_VALUE_TRANSFER: "A batched call moves ETH, which the batch renderer cannot describe.",
  BATCH_CONTRACT_CREATION: "A batched call creates a contract, which cannot be clear-signed.",
  BATCH_INTERPOLATION_INCOMPLETE: "Not every call in the batch could be rendered into the intent text.",
  BATCH_EMPTY: "The batch contains no calls.",
  CYCLIC_INCLUDES: "The descriptor includes itself, directly or through another descriptor.",
};

/** Tooltip text for a warning code; a generic sentence for codes this map does not know. */
export function explainWarning(code: string): string {
  return EXPLAIN[code] ?? `Warning ${code} from the clear-signing library.`;
}
