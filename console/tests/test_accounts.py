import json
import os
import stat

import pytest

from catence_console.accounts import (
    ACCOUNTS_FORMAT_VERSION,
    AccountExistsError,
    AccountNotFoundError,
    AccountValidationError,
    AccountsStoreError,
    ConsoleAccount,
    account_can_access,
    add_account,
    default_accounts_path,
    env_account,
    find_account,
    hash_password,
    load_accounts,
    remove_account,
    save_accounts,
    update_account,
    verify_password,
)

CREATED_AT = "2026-09-28T12:00:00+00:00"
TEST_PASSWORD_HASH = hash_password("correct horse")


def write_store(path, *entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"formatVersion": ACCOUNTS_FORMAT_VERSION, "accounts": list(entries)}),
        encoding="utf-8",
    )
    return path


def entry(**overrides):
    payload = {
        "username": "martina",
        "passwordHash": TEST_PASSWORD_HASH,
        "role": "member",
        "athletes": ["martina"],
        "createdAt": CREATED_AT,
    }
    payload.update(overrides)
    return payload


def test_default_accounts_path_lives_beside_the_chat_history(tmp_path):
    assert default_accounts_path(tmp_path) == tmp_path / "console" / "accounts.json"


def test_save_and_load_roundtrip_writes_a_private_file(tmp_path):
    path = default_accounts_path(tmp_path)
    account = add_account(path, username="martina", password="correct horse", role="member", athletes=["martina"])

    assert load_accounts(path) == [account]
    assert find_account(path, "martina") == account
    assert find_account(path, "nobody") is None
    assert sorted(item.name for item in path.parent.iterdir()) == ["accounts.json"]
    assert path.read_text(encoding="utf-8").endswith("\n")
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["formatVersion"] == ACCOUNTS_FORMAT_VERSION
    assert payload["accounts"][0]["passwordHash"].startswith("$2")


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_store_permissions_are_private(tmp_path):
    path = default_accounts_path(tmp_path)
    add_account(path, username="martina", password="correct horse", role="member", athletes=[])

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700


def test_load_missing_file_is_an_empty_store(tmp_path):
    assert load_accounts(tmp_path / "missing" / "accounts.json") == []


def test_load_rejects_malformed_json(tmp_path):
    path = tmp_path / "accounts.json"
    path.write_text("{not json", encoding="utf-8")

    with pytest.raises(AccountsStoreError, match="not valid JSON"):
        load_accounts(path)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (["not", "an", "object"], "must be a JSON object"),
        ({"formatVersion": True, "accounts": []}, "formatVersion"),
        ({"formatVersion": 2, "accounts": []}, "formatVersion"),
        ({"formatVersion": 1}, "accounts list"),
        ({"formatVersion": 1, "accounts": {}}, "accounts list"),
        ({"formatVersion": 1, "accounts": [], "extra": True}, "unknown fields"),
    ],
)
def test_load_rejects_structural_problems(tmp_path, payload, message):
    path = tmp_path / "accounts.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(AccountsStoreError, match=message):
        load_accounts(path)


def test_load_rejects_a_non_object_account(tmp_path):
    path = write_store(tmp_path / "accounts.json", "martina")

    with pytest.raises(AccountsStoreError, match="non-object account"):
        load_accounts(path)


def test_load_rejects_unknown_and_missing_fields(tmp_path):
    unknown = write_store(tmp_path / "unknown.json", entry(nickname="m"))
    with pytest.raises(AccountsStoreError, match="unknown fields"):
        load_accounts(unknown)

    incomplete = entry()
    del incomplete["createdAt"]
    missing = write_store(tmp_path / "missing.json", incomplete)
    with pytest.raises(AccountsStoreError, match="missing fields"):
        load_accounts(missing)


@pytest.mark.parametrize(
    "overrides",
    [
        {"username": "has space"},
        {"username": "x" * 65},
        {"username": ""},
        {"passwordHash": "plaintext"},
        {"role": "owner"},
        {"athletes": "everyone"},
        {"athletes": ["Martina"]},
        {"athletes": ["under_score"]},
        {"athletes": ["9starts-with-a-digit"]},
        {"createdAt": "yesterday"},
    ],
)
def test_load_rejects_invalid_fields(tmp_path, overrides):
    path = write_store(tmp_path / "accounts.json", entry(**overrides))

    with pytest.raises(AccountsStoreError, match="invalid"):
        load_accounts(path)


def test_load_rejects_an_admin_with_an_athlete_list(tmp_path):
    path = write_store(tmp_path / "accounts.json", entry(role="admin", athletes=["martina"]))

    with pytest.raises(AccountsStoreError, match="must use athletes 'all'"):
        load_accounts(path)


def test_load_rejects_duplicate_usernames(tmp_path):
    path = write_store(tmp_path / "accounts.json", entry(), entry(passwordHash=hash_password("other")))

    with pytest.raises(AccountsStoreError, match="duplicate usernames"):
        load_accounts(path)


def test_load_normalizes_duplicate_athlete_ids(tmp_path):
    path = write_store(tmp_path / "accounts.json", entry(athletes=["martina", "martina"]))

    loaded = load_accounts(path)

    assert loaded[0].athletes == ["martina"]


@pytest.mark.skipif(not hasattr(os, "geteuid") or os.geteuid() == 0, reason="POSIX permissions without root")
def test_load_reports_unreadable_files(tmp_path):
    path = tmp_path / "accounts.json"
    path.write_text("{}", encoding="utf-8")
    path.chmod(0)

    try:
        with pytest.raises(AccountsStoreError, match="Could not read"):
            load_accounts(path)
    finally:
        path.chmod(0o600)


def test_save_reports_unwritable_destinations(tmp_path):
    (tmp_path / "console").write_text("not a directory", encoding="utf-8")

    with pytest.raises(AccountsStoreError, match="Could not create"):
        save_accounts(default_accounts_path(tmp_path), [])


def test_save_rejects_invalid_accounts(tmp_path):
    path = default_accounts_path(tmp_path)

    with pytest.raises(AccountValidationError, match="username"):
        save_accounts(path, [ConsoleAccount("bad name", TEST_PASSWORD_HASH, "member", [], CREATED_AT)])

    account = add_account(path, username="martina", password="correct horse", role="member", athletes=[])
    with pytest.raises(AccountValidationError, match="unique"):
        save_accounts(path, [account, account])


def test_hash_and_verify_password_roundtrip():
    hashed = hash_password("correct horse")

    assert hashed.startswith("$2")
    assert verify_password(hashed, "correct horse") is True
    assert verify_password(hashed, "wrong") is False
    assert verify_password("not-a-bcrypt-hash", "correct horse") is False
    assert verify_password("", "correct horse") is False


def test_hash_password_rejects_empty_passwords():
    with pytest.raises(AccountValidationError, match="empty"):
        hash_password("")


def test_verify_password_accepts_an_account():
    account = ConsoleAccount("martina", hash_password("pw"), "member", [], CREATED_AT)

    assert verify_password(account, "pw") is True
    assert verify_password(account, "nope") is False


def test_add_rejects_duplicates_and_invalid_roles(tmp_path):
    path = default_accounts_path(tmp_path)
    add_account(path, username="martina", password="correct horse", role="member", athletes=[])

    with pytest.raises(AccountExistsError, match="already exists"):
        add_account(path, username="martina", password="other", role="member", athletes=[])
    with pytest.raises(AccountValidationError, match="role"):
        add_account(path, username="other", password="correct horse", role="owner", athletes=[])
    with pytest.raises(AccountValidationError, match="empty"):
        add_account(path, username="other", password="", role="member", athletes=[])


def test_add_admin_requires_all_athletes(tmp_path):
    path = default_accounts_path(tmp_path)

    account = add_account(path, username="coach", password="correct horse", role="admin", athletes="all")
    assert (account.role, account.athletes) == ("admin", "all")

    with pytest.raises(AccountValidationError, match="must use athletes 'all'"):
        add_account(path, username="other", password="correct horse", role="admin", athletes=["martina"])


def test_remove_account_raises_for_unknown_users(tmp_path):
    path = default_accounts_path(tmp_path)
    account = add_account(path, username="martina", password="correct horse", role="member", athletes=[])

    assert remove_account(path, "martina") == account
    assert load_accounts(path) == []

    with pytest.raises(AccountNotFoundError, match="not found"):
        remove_account(path, "martina")


def test_update_account_changes_password_role_and_grants(tmp_path):
    path = default_accounts_path(tmp_path)
    added = add_account(path, username="martina", password="first", role="member", athletes=[])

    updated = update_account(path, "martina", password="second")
    assert verify_password(updated, "second") is True
    assert verify_password(updated, "first") is False
    assert updated.created_at == added.created_at

    updated = update_account(path, "martina", athletes=["martina"])
    assert updated.athletes == ["martina"]

    updated = update_account(path, "martina", role="admin")
    assert (updated.role, updated.athletes) == ("admin", "all")

    demoted = update_account(path, "martina", role="member")
    assert (demoted.role, demoted.athletes) == ("member", "all")
    assert load_accounts(path) == [demoted]


def test_update_account_raises_for_no_changes_and_unknown_users(tmp_path):
    path = default_accounts_path(tmp_path)
    add_account(path, username="martina", password="correct horse", role="member", athletes=[])

    with pytest.raises(AccountValidationError, match="No changes"):
        update_account(path, "martina")
    with pytest.raises(AccountNotFoundError, match="not found"):
        update_account(path, "nobody", password="correct horse")
    with pytest.raises(AccountValidationError, match="must use athletes 'all'"):
        update_account(path, "martina", role="admin", athletes=["martina"])


def test_account_can_access_honors_role_and_grants():
    admin = ConsoleAccount("coach", TEST_PASSWORD_HASH, "admin", "all", CREATED_AT)
    member_with_all = ConsoleAccount("allie", TEST_PASSWORD_HASH, "member", "all", CREATED_AT)
    member = ConsoleAccount("martina", TEST_PASSWORD_HASH, "member", ["martina"], CREATED_AT)
    empty = ConsoleAccount("newcomer", TEST_PASSWORD_HASH, "member", [], CREATED_AT)

    assert account_can_access(admin, "anyone") is True
    assert account_can_access(member_with_all, "anyone") is True
    assert account_can_access(member, "martina") is True
    assert account_can_access(member, "someone-else") is False
    assert account_can_access(empty, "martina") is False


def test_env_account_requires_both_variables(monkeypatch):
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    assert env_account() is None

    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", "coach")
    assert env_account() is None

    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", "$2b$12$example")
    account = env_account()
    assert account is not None
    assert (account.username, account.role, account.athletes) == ("coach", "admin", "all")
    assert account.password_hash == "$2b$12$example"
