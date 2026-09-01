/**
 * WolfAdapter — shape type for the Wolf provider adapter.
 *
 * The driver model ({@link ../Drivers/WolfDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module WolfAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * WolfAdapterShape — per-instance Wolf adapter contract.
 */
export interface WolfAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
