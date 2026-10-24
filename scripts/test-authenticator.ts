// A software passkey for tests: a real P-256 key that produces genuine WebAuthn registration and authentication
// responses ("none" attestation, user present + verified), so the server's real verification code runs end to end.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string) => createHash("sha256").update(b).digest();

export class TestAuthenticator {
	private readonly privateKey: KeyObject;
	private readonly publicJwk: { x: string; y: string };
	readonly credentialId = randomBytes(16);
	private counter = 0;
	private readonly rpId: string;
	private readonly origin: string;

	constructor(rpId: string, origin: string) {
		this.rpId = rpId;
		this.origin = origin;
		const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		this.privateKey = privateKey;
		this.publicJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
	}

	private clientData(type: string, challenge: string, origin = this.origin) {
		return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}

	private authData(flags: number, attested?: Buffer) {
		const count = Buffer.alloc(4);
		count.writeUInt32BE(++this.counter);
		return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)]);
	}

	/** navigator.credentials.create() */
	register(options: { challenge: string }, origin?: string) {
		const cose = new Map<number, number | Uint8Array>([
			[1, 2], // kty: EC2
			[3, -7], // alg: ES256
			[-1, 1], // crv: P-256
			[-2, Buffer.from(this.publicJwk.x, "base64url")],
			[-3, Buffer.from(this.publicJwk.y, "base64url")],
		]);
		const idLength = Buffer.alloc(2);
		idLength.writeUInt16BE(this.credentialId.length);
		const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, Buffer.from(encodeCBOR(cose as never))]);
		const authData = this.authData(0x45, attested); // UP | UV | AT
		const attestationObject = encodeCBOR(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
		return {
			id: b64url(this.credentialId),
			rawId: b64url(this.credentialId),
			type: "public-key",
			response: {
				clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, origin)),
				attestationObject: b64url(attestationObject),
				transports: ["internal"],
			},
			clientExtensionResults: {},
		};
	}

	/** navigator.credentials.get() */
	authenticate(options: { challenge: string }, origin?: string) {
		const authData = this.authData(0x05); // UP | UV
		const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
		const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
		return {
			id: b64url(this.credentialId),
			rawId: b64url(this.credentialId),
			type: "public-key",
			response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature) },
			clientExtensionResults: {},
		};
	}
}
