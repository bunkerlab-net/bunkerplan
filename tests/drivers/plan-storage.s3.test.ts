import { S3_ENDPOINT, s3Storage } from "./backends.ts";
import { describePlanStorage } from "./contract/plan-storage.ts";

/** Separate from the R2 file on purpose - see the note there. */
describePlanStorage("S3 (MinIO)", s3Storage, {
  skip: S3_ENDPOINT === undefined,
});
