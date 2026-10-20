/**
 * @osp/op-client — READ-ONLY OpenProject v3 client contract + types.
 *
 * Phase 0 ships the interface, faithful OP v3 response types, and a placeholder
 * impl (the read-only guard is real; everything else throws "implemented by Agent A").
 */
export * from "./types";
export * from "./client";
export * from "./impl";
export * from "./util";
export * from "./paginate";
export * from "./health";
export * from "./instrument";
export * from "./timeout";
export * from "./hardCancel";
export * from "./journal";
export * from "./reconstruct";
export * from "./assignee-intervals";
export * from "./identity";
export * from "./statusCatalog";
