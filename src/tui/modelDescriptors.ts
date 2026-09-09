import type { ModelDescriptor } from "../core/types.js";

/** Descriptor lookup for the currently active runtime/model list. */
export const modelDescriptorIndex = new Map<string, ModelDescriptor>();

export function rememberModelDescriptors(descriptors: ModelDescriptor[]): void {
  modelDescriptorIndex.clear();
  for (const descriptor of descriptors) {
    modelDescriptorIndex.set(descriptor.id, descriptor);
    if (descriptor.modelName) {
      modelDescriptorIndex.set(descriptor.modelName, descriptor);
    }
    if (descriptor.displayName) {
      modelDescriptorIndex.set(descriptor.displayName, descriptor);
    }
  }
}
