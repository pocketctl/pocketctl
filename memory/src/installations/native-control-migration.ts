/** Native metadata observation is independent of HTTP feed cursors/ACKs.
 * It grants no authority; current native controls still fence every read. */
export const NATIVE_CONTROL_OBSERVATION_MIGRATION={version:97,statements:[
 `CREATE TABLE memory_native_control_observations(
  installation_id UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
  control_revision BIGINT NOT NULL CHECK(control_revision>0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
]} as const
