import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { VarInput } from "@/components/editor/VarInput";
import { useVarScope } from "@/components/editor/varScopeContext";
import {
  AUTH_BLOCKS,
  type AWSV4,
  type Auth,
  type BlockAuthType,
  type Digest,
  type Hawk,
  type JWT,
  type JWTAlgorithm,
  type NTLM,
} from "@/lib/model";
import { cn } from "@/lib/utils";
import type { SecretField } from "./auth";
import { Field, SecretInput, fieldClass } from "./authFields";

export interface OtherAuthFieldsProps {
  auth: Auth;
  onChange: (update: (auth: Auth) => Auth) => void;
  /** The "Move to secret variable" hint under a literal secret, or null. */
  hint: (field: SecretField) => React.ReactNode;
}

function Help({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function Text(props: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field id={props.id} label={props.label}>
      <VarInput
        id={props.id}
        ariaLabel={props.label}
        className={cn(fieldClass, props.className)}
        placeholder={props.placeholder}
        value={props.value}
        onChange={props.onChange}
      />
    </Field>
  );
}

function Secret(props: {
  id: string;
  label: string;
  field: SecretField;
  value: string;
  hint: OtherAuthFieldsProps["hint"];
  onChange: (v: string) => void;
}) {
  return (
    <Field id={props.id} label={props.label} hint={props.hint(props.field)}>
      <SecretInput id={props.id} label={props.label} value={props.value} onChange={props.onChange} />
    </Field>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="col-start-2 flex cursor-pointer items-center gap-2 text-xs">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}

function Checks({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">{children}</div>;
}

/** A select whose "" value is shown as `auto` (Radix Select can't hold ""). */
function Choice<T extends string>(props: {
  id: string;
  label: string;
  value: T | "";
  options: ReadonlyArray<readonly [T | "", string]>;
  onChange: (v: T | "") => void;
}) {
  const AUTO = "__auto";
  return (
    <Field id={props.id} label={props.label}>
      <Select value={props.value || AUTO} onValueChange={(v) => props.onChange(v === AUTO ? "" : (v as T))}>
        <SelectTrigger id={props.id} className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map(([v, label]) => (
            <SelectItem key={v || AUTO} value={v || AUTO}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Patches one settings block of auth, creating it when it's missing. */
function usePatch<K extends BlockAuthType>(type: K, onChange: OtherAuthFieldsProps["onChange"]) {
  return (patch: Partial<NonNullable<Auth[K]>>) =>
    onChange((a) => ({
      ...a,
      [type]: { ...((a[type] as object | undefined) ?? AUTH_BLOCKS[type]()), ...patch },
    }));
}

function DigestFields({
  d,
  set,
  hint,
}: {
  d: Digest;
  set: (p: Partial<Digest>) => void;
  hint: OtherAuthFieldsProps["hint"];
}) {
  return (
    <>
      <Text
        id="digest-username"
        label="Username"
        value={d.username}
        onChange={(username) => set({ username })}
      />
      <Secret
        id="digest-password"
        label="Password"
        field="digestPassword"
        value={d.password}
        hint={hint}
        onChange={(password) => set({ password })}
      />
      <Choice
        id="digest-algorithm"
        label="Algorithm"
        value={d.algorithm}
        options={[
          ["", "Server's choice"],
          ["SHA-256", "SHA-256"],
          ["SHA-256-sess", "SHA-256-sess"],
          ["MD5", "MD5"],
          ["MD5-sess", "MD5-sess"],
        ]}
        onChange={(algorithm) => set({ algorithm })}
      />
      <Checks>
        <Check
          label="Hash the body too (qop auth-int)"
          checked={d.qop === "auth-int"}
          onChange={(v) => set({ qop: v ? "auth-int" : "" })}
        />
      </Checks>
      <Help>
        The request is sent without auth first. When the server answers 401 with a Digest challenge, it&apos;s
        sent again once with the answer; both exchanges show in the Debug tab.
      </Help>
    </>
  );
}

function AWSFields({
  w,
  set,
  hint,
}: {
  w: AWSV4;
  set: (p: Partial<AWSV4>) => void;
  hint: OtherAuthFieldsProps["hint"];
}) {
  return (
    <>
      <Text
        id="aws-access-key"
        label="Access key"
        value={w.accessKey}
        onChange={(accessKey) => set({ accessKey })}
      />
      <Secret
        id="aws-secret-key"
        label="Secret key"
        field="awsSecretKey"
        value={w.secretKey}
        hint={hint}
        onChange={(secretKey) => set({ secretKey })}
      />
      <Secret
        id="aws-session-token"
        label="Session token"
        field="awsSessionToken"
        value={w.sessionToken}
        hint={hint}
        onChange={(sessionToken) => set({ sessionToken })}
      />
      <Text
        id="aws-region"
        label="Region"
        placeholder="us-east-1"
        className="w-48"
        value={w.region}
        onChange={(region) => set({ region })}
      />
      <Text
        id="aws-service"
        label="Service"
        placeholder="execute-api"
        className="w-48"
        value={w.service}
        onChange={(service) => set({ service })}
      />
      <Checks>
        <Check
          label="Don't sign the body (UNSIGNED-PAYLOAD, S3 only)"
          checked={w.unsignedPayload}
          onChange={(unsignedPayload) => set({ unsignedPayload })}
        />
      </Checks>
      <Help>
        Signed just before sending, after every header is set. The session token is only needed for temporary
        credentials.
      </Help>
    </>
  );
}

const JWT_ALGORITHMS: JWTAlgorithm[] = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

function JWTFields({
  j,
  set,
  hint,
}: {
  j: JWT;
  set: (p: Partial<JWT>) => void;
  hint: OtherAuthFieldsProps["hint"];
}) {
  const variables = useVarScope();
  const alg = j.algorithm || "HS256";
  const hmac = alg.startsWith("HS");
  const query = j.placement === "query";
  return (
    <>
      <Choice
        id="jwt-algorithm"
        label="Algorithm"
        value={alg}
        options={JWT_ALGORITHMS.map((a) => [a, a] as const)}
        onChange={(v) => set({ algorithm: v === "HS256" ? "" : v })}
      />
      <Secret
        id="jwt-secret"
        label={hmac ? "Secret" : "Private key"}
        field="jwtSecret"
        value={j.secret}
        hint={hint}
        onChange={(secret) => set({ secret })}
      />
      {hmac ? (
        <Checks>
          <Check
            label="The secret is base64 encoded"
            checked={j.secretBase64}
            onChange={(secretBase64) => set({ secretBase64 })}
          />
        </Checks>
      ) : (
        <Help>
          Paste the PEM private key (PKCS#8, PKCS#1 or SEC1); line breaks may be lost, that&apos;s fine.
        </Help>
      )}
      <Field id="jwt-payload" label="Payload" top>
        <div className="h-28 overflow-hidden rounded-md border bg-card">
          <CodeEditor
            ariaLabel="JWT payload"
            className="h-full"
            language="json"
            placeholder='{"sub": "{{userId}}"}'
            value={j.payload}
            onChange={(payload) => set({ payload })}
            variables={variables}
          />
        </div>
      </Field>
      <Field id="jwt-header" label="Header fields" top>
        <div className="h-16 overflow-hidden rounded-md border bg-card">
          <CodeEditor
            ariaLabel="JWT header fields"
            className="h-full"
            language="json"
            placeholder='{"kid": "key-1"}'
            value={j.header}
            onChange={(header) => set({ header })}
            variables={variables}
          />
        </div>
      </Field>
      <Field id="jwt-lifetime" label="Lifetime (s)">
        <Input
          id="jwt-lifetime"
          type="number"
          min={0}
          className="w-32"
          value={j.lifetimeSeconds || ""}
          placeholder="No expiry"
          onChange={(e) => set({ lifetimeSeconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
        />
      </Field>
      <Checks>
        <Check
          label="Add issued at (iat)"
          checked={!j.disableIssuedAt}
          onChange={(v) => set({ disableIssuedAt: !v })}
        />
        <Check
          label="Add a random token id (jti)"
          checked={j.addJti}
          onChange={(addJti) => set({ addJti })}
        />
      </Checks>
      <Choice
        id="jwt-placement"
        label="Send in"
        value={query ? "query" : "header"}
        options={[
          ["header", "Authorization header"],
          ["query", "Query parameter"],
        ]}
        onChange={(v) => set({ placement: v === "query" ? "query" : "" })}
      />
      {query ? (
        <Text
          id="jwt-query-param"
          label="Parameter"
          placeholder="token"
          className="w-40"
          value={j.queryParam}
          onChange={(queryParam) => set({ queryParam })}
        />
      ) : (
        <Text
          id="jwt-prefix"
          label="Prefix"
          placeholder="Bearer"
          className="w-40"
          value={j.headerPrefix}
          onChange={(headerPrefix) => set({ headerPrefix })}
        />
      )}
      <Help>
        A new token is signed for every send. iat, exp (now plus the lifetime) and jti are added unless the
        payload sets them. {"{{variables}}"} in the JSON are escaped like in a JSON body.
      </Help>
    </>
  );
}

function HawkFields({
  h,
  set,
  hint,
}: {
  h: Hawk;
  set: (p: Partial<Hawk>) => void;
  hint: OtherAuthFieldsProps["hint"];
}) {
  return (
    <>
      <Text id="hawk-id" label="Hawk ID" value={h.id} onChange={(id) => set({ id })} />
      <Secret
        id="hawk-key"
        label="Key"
        field="hawkKey"
        value={h.key}
        hint={hint}
        onChange={(key) => set({ key })}
      />
      <Choice
        id="hawk-algorithm"
        label="Algorithm"
        value={h.algorithm || "sha256"}
        options={[
          ["sha256", "SHA-256"],
          ["sha1", "SHA-1"],
        ]}
        onChange={(v) => set({ algorithm: v === "sha1" ? "sha1" : "" })}
      />
      <Text id="hawk-ext" label="Ext" value={h.ext} onChange={(ext) => set({ ext })} />
      <Text id="hawk-app" label="App" value={h.app} onChange={(app) => set({ app })} />
      <Text id="hawk-dlg" label="Delegated by" value={h.dlg} onChange={(dlg) => set({ dlg })} />
      <Checks>
        <Check
          label="Include a payload hash"
          checked={h.payloadHash}
          onChange={(payloadHash) => set({ payloadHash })}
        />
      </Checks>
      <Help>A new timestamp and nonce are used for every send.</Help>
    </>
  );
}

function NTLMFields({
  n,
  set,
  hint,
}: {
  n: NTLM;
  set: (p: Partial<NTLM>) => void;
  hint: OtherAuthFieldsProps["hint"];
}) {
  return (
    <>
      <Text
        id="ntlm-username"
        label="Username"
        value={n.username}
        onChange={(username) => set({ username })}
      />
      <Secret
        id="ntlm-password"
        label="Password"
        field="ntlmPassword"
        value={n.password}
        hint={hint}
        onChange={(password) => set({ password })}
      />
      <Text id="ntlm-domain" label="Domain" value={n.domain} onChange={(domain) => set({ domain })} />
      <Text
        id="ntlm-workstation"
        label="Workstation"
        value={n.workstation}
        onChange={(workstation) => set({ workstation })}
      />
      <Help>The NTLM handshake runs on a connection of its own for each send. Only NTLMv2 is supported.</Help>
    </>
  );
}

/** The fields of Digest, AWS Signature v4, JWT, Hawk and NTLM auth (a lazy chunk). */
export function OtherAuthFields({ auth, onChange, hint }: OtherAuthFieldsProps) {
  const digest = usePatch("digest", onChange);
  const aws = usePatch("awsv4", onChange);
  const jwt = usePatch("jwt", onChange);
  const hawk = usePatch("hawk", onChange);
  const ntlm = usePatch("ntlm", onChange);
  switch (auth.type) {
    case "digest":
      return <DigestFields d={auth.digest ?? AUTH_BLOCKS.digest()} set={digest} hint={hint} />;
    case "awsv4":
      return <AWSFields w={auth.awsv4 ?? AUTH_BLOCKS.awsv4()} set={aws} hint={hint} />;
    case "jwt":
      return <JWTFields j={auth.jwt ?? AUTH_BLOCKS.jwt()} set={jwt} hint={hint} />;
    case "hawk":
      return <HawkFields h={auth.hawk ?? AUTH_BLOCKS.hawk()} set={hawk} hint={hint} />;
    case "ntlm":
      return <NTLMFields n={auth.ntlm ?? AUTH_BLOCKS.ntlm()} set={ntlm} hint={hint} />;
    default:
      return null;
  }
}
