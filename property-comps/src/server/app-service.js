import { createRegistry } from "../adapters/registry.js";
import { createPropertyService } from "../application/property-service.js";

let service;

/** One service per warm process. County responses also cache inside the adapters. */
export const getService = () => {
  service ??= createPropertyService(createRegistry());
  return service;
};
