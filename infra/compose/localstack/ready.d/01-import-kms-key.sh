#!/bin/bash
set -euo pipefail

python3 - <<'PYEOF'
import base64
import boto3
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ALIAS = "alias/eventform-endpoint-secrets"
CUSTOM_KEY_ID = "11111111-2222-4333-8444-555555555555"
MATERIAL_PATH = "/etc/eventform/kms-key-material.b64"

kms = boto3.client(
    "kms",
    endpoint_url="http://localhost:4566",
    region_name="us-east-1",
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

try:
    meta = kms.describe_key(KeyId=ALIAS)["KeyMetadata"]
    if meta["KeyState"] == "Enabled":
        print("eventform KMS key already enabled, skipping import")
        raise SystemExit(0)
    key_id = meta["KeyId"]
except kms.exceptions.NotFoundException:
    key = kms.create_key(
        Description="eventform endpoint HMAC secrets",
        Origin="EXTERNAL",
        Tags=[{"TagKey": "_custom_id_", "TagValue": CUSTOM_KEY_ID}],
    )
    key_id = key["KeyMetadata"]["KeyId"]
    kms.create_alias(AliasName=ALIAS, TargetKeyId=key_id)

with open(MATERIAL_PATH) as f:
    material = base64.b64decode(f.read().strip())
assert len(material) == 32, "key material must be 32 bytes"

params = kms.get_parameters_for_import(
    KeyId=key_id,
    WrappingAlgorithm="RSAES_OAEP_SHA_256",
    WrappingKeySpec="RSA_2048",
)
wrapping_key = serialization.load_der_public_key(params["PublicKey"])
wrapped = wrapping_key.encrypt(
    material,
    padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
)
kms.import_key_material(
    KeyId=key_id,
    ImportToken=params["ImportToken"],
    EncryptedKeyMaterial=wrapped,
    ExpirationModel="KEY_MATERIAL_DOES_NOT_EXPIRE",
)
print(f"imported fixed key material into {key_id}")
PYEOF
