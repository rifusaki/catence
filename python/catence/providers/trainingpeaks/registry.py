"""Explicit read-only allowlist for TrainingPeaks reads.

The worker only imports/calls the client surface named here. The fork's
other ~80 tool methods (workout mutation, events, fitness, equipment,
coach functions) are structurally unreachable from this worker; the
Node-side registry is the authoritative allowlist and mirrors this list.
"""

TP_READ_ENDPOINTS = {
    "planned_workouts": ("workouts",),
    "zones": ("settings",),
    "athlete_settings": ("user",),
}

WORKOUTS_ENDPOINT_TEMPLATE = "/fitness/v6/athletes/{athlete_id}/workouts/{start}/{end}"
SETTINGS_ENDPOINT_TEMPLATE = "/fitness/v1/athletes/{athlete_id}/settings"
USER_ENDPOINT = "/users/v3/user"

MUTATION_PREFIXES = ("tp_create_", "tp_update_", "tp_delete_", "tp_copy_", "tp_reorder_", "tp_pair_", "tp_unpair_", "tp_set_", "tp_add_", "tp_upload_", "tp_log_", "tp_move_", "tp_swap_")


def assert_read_only_registry() -> None:
    """Fail closed if a future registry edit accidentally exposes a mutation."""
    for endpoints in TP_READ_ENDPOINTS.values():
        for endpoint in endpoints:
            if endpoint.startswith(MUTATION_PREFIXES):
                raise RuntimeError(f"Unsafe TrainingPeaks endpoint in read registry: {endpoint}")
