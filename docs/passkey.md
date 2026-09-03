# Passkey (/docs/plugins/passkey)

Passkey

Passkeys are a secure, passwordless authentication method using cryptographic key pairs, supported by WebAuthn and FIDO2 standards in web browsers. They replace passwords with unique key pairs: a private key stored on the user's device and a public key shared with the website. Users can log in using biometrics, PINs, or security keys, providing strong, phishing-resistant authentication without traditional passwords.

The passkey plugin implementation is powered by [SimpleWebAuthn](https://simplewebauthn.dev/) behind the scenes.

## Installation [#installation]

<Steps>
  <Step>
    ### Install the plugin [#install-the-plugin]

    <CodeBlockTabs defaultValue="npm" groupId="persist-install">
      <CodeBlockTabsList>
        <CodeBlockTabsTrigger value="npm">
          npm
        </CodeBlockTabsTrigger>

        <CodeBlockTabsTrigger value="pnpm">
          pnpm
        </CodeBlockTabsTrigger>

        <CodeBlockTabsTrigger value="yarn">
          yarn
        </CodeBlockTabsTrigger>

        <CodeBlockTabsTrigger value="bun">
          bun
        </CodeBlockTabsTrigger>
      </CodeBlockTabsList>

      <CodeBlockTab value="npm">
        ```bash
        npm install @better-auth/passkey
        ```
      </CodeBlockTab>

      <CodeBlockTab value="pnpm">
        ```bash
        pnpm add @better-auth/passkey
        ```
      </CodeBlockTab>

      <CodeBlockTab value="yarn">
        ```bash
        yarn add @better-auth/passkey
        ```
      </CodeBlockTab>

      <CodeBlockTab value="bun">
        ```bash
        bun add @better-auth/passkey
        ```
      </CodeBlockTab>
    </CodeBlockTabs>

  </Step>

  <Step>
    ### Add the plugin to your auth config [#add-the-plugin-to-your-auth-config]

    To add the passkey plugin to your auth config, you need to import the plugin and pass it to the `plugins` option of the auth instance.

    ```ts title="auth.ts"
    import { betterAuth } from "better-auth"
    import { passkey } from "@better-auth/passkey" // [!code highlight]

    export const auth = betterAuth({
        plugins: [
            passkey(), // [!code highlight]
        ],
    })
    ```

  </Step>

  <Step>
    ### Migrate the database [#migrate-the-database]

    Run the migration or generate the schema to add the necessary fields and tables to the database.

    <Tabs items="[&#x22;migrate&#x22;, &#x22;generate&#x22;]">
      <Tab value="migrate">
        <CodeBlockTabs defaultValue="npm" groupId="persist-install">
          <CodeBlockTabsList>
            <CodeBlockTabsTrigger value="npm">
              npm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="pnpm">
              pnpm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="yarn">
              yarn
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="bun">
              bun
            </CodeBlockTabsTrigger>
          </CodeBlockTabsList>

          <CodeBlockTab value="npm">
            ```bash
            npx auth migrate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="pnpm">
            ```bash
            pnpm dlx auth migrate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="yarn">
            ```bash
            yarn dlx auth migrate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="bun">
            ```bash
            bun x auth migrate
            ```
          </CodeBlockTab>
        </CodeBlockTabs>
      </Tab>

      <Tab value="generate">
        <CodeBlockTabs defaultValue="npm" groupId="persist-install">
          <CodeBlockTabsList>
            <CodeBlockTabsTrigger value="npm">
              npm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="pnpm">
              pnpm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="yarn">
              yarn
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="bun">
              bun
            </CodeBlockTabsTrigger>
          </CodeBlockTabsList>

          <CodeBlockTab value="npm">
            ```bash
            npx auth generate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="pnpm">
            ```bash
            pnpm dlx auth generate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="yarn">
            ```bash
            yarn dlx auth generate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="bun">
            ```bash
            bun x auth generate
            ```
          </CodeBlockTab>
        </CodeBlockTabs>
      </Tab>
    </Tabs>

    See the [Schema](#schema) section to add the fields manually.

  </Step>

  <Step>
    ### Add the client plugin [#add-the-client-plugin]

    ```ts title="auth-client.ts"
    import { createAuthClient } from "better-auth/client"
    import { passkeyClient } from "@better-auth/passkey/client" // [!code highlight]

    export const authClient = createAuthClient({
        plugins: [
            passkeyClient() // [!code highlight]
        ]
    })
    ```

  </Step>
</Steps>

## Configuration (Optional) [#configuration-optional]

You can customize the passkey plugin to support passkey-first onboarding or WebAuthn extensions.

```ts title="auth.ts"
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';

export const auth = betterAuth({
  plugins: [
    passkey({
      registration: {
        // Default: true. Set false for passkey-first onboarding.
        requireSession: false,
        // Required if requireSession is false and no session exists.
        resolveUser: async ({ ctx, context }) => {
          // Validate context (e.g., a signed token), then create or load a user.
          return { id: 'user-id', name: 'user@example.com' };
        },
        // Optional server-defined extensions
        extensions: { credProps: true },
      },
      authentication: {
        // Optional server-defined extensions
        extensions: { credProps: true },
      },
    }),
  ],
});
```

### Passkey-first registration (pre-auth) [#passkey-first-registration-pre-auth]

When `registration.requireSession` is `false`, passkey registration can be initiated without a session. You can pass an opaque `context` to the registration options endpoint; it will be forwarded to `resolveUser`.

```ts
await auth.api.generatePasskeyRegistrationOptions({
  context: 'signed-registration-token',
});
```

When using passkey-first flows (`registration.requireSession: false`), pass the same `context` from the client when registering the passkey so the server can resolve the user during verification:

```ts
await authClient.passkey.addPasskey({
  name: 'Primary passkey',
  context: 'signed-registration-token',
  createSession: true,
});
```

When `createSession` is `true`, successful verification sets the session cookie and returns the `session` and `user` with the registered passkey. If you want to avoid creating a user before the WebAuthn ceremony succeeds, create or load the user in `registration.afterVerification` and return its `userId`.

## Usage [#usage]

### Add/Register a passkey [#addregister-a-passkey]

To add or register a passkey make sure a user is authenticated and then call the `passkey.addPasskey` function provided by the client.

**Endpoint:** `POST /passkey/add-passkey`

### Client Side

```ts
const { data, error } = await authClient.passkey.addPasskey({
  name: 'example-passkey-name', // An optional name to label the authenticator account being registered. If not provided, it will default to the user's email address or user ID
  authenticatorAttachment: 'cross-platform', // You can also specify the type of authenticator you want to register. Default behavior allows both platform and cross-platform passkeys
  extensions, // Optional WebAuthn extensions (e.g., PRF, credProps, largeBlob)
  returnWebAuthnResponse, // Return WebAuthn response and extension results
  context, // Optional context for passkey-first registration flows. Forwarded to `registration.resolveUser`.
  createSession, // Create a session after successfully registering the passkey. The response includes the session and user when enabled.
});
```

### Type Definition

```ts
type addPasskey = {
    /**
     * An optional name to label the authenticator account being registered. If not provided, it will default to the user's email address or user ID
    */
    name?: string = "example-passkey-name"
    /**
     * You can also specify the type of authenticator you want to register. Default behavior allows both platform and cross-platform passkeys
    */
    authenticatorAttachment?: "platform" | "cross-platform" = "cross-platform"
    /**
     * Optional WebAuthn extensions (e.g., PRF, credProps, largeBlob)
     */
    extensions?: AuthenticationExtensionsClientInputs
    /**
     * Return WebAuthn response and extension results
     */
    returnWebAuthnResponse?: boolean
    /**
     * Optional context for passkey-first registration flows. Forwarded to `registration.resolveUser`.
     */
    context?: string
    /**
     * Create a session after successfully registering the passkey. The
     * response includes the session and user when enabled.
     */
    createSession?: boolean
}
```

<Callout>
  Setting `throw: true` in the fetch options has no effect for the register and sign-in passkey responses — they will always return a data object containing the error object.
</Callout>

### Sign in with a passkey [#sign-in-with-a-passkey]

To sign in with a passkey you can use the `signIn.passkey` method. This will prompt the user to sign in with their passkey.

**Endpoint:** `POST /sign-in/passkey`

### Client Side

```ts
const { data, error } = await authClient.signIn.passkey({
  autoFill: true, // Browser autofill, a.k.a. Conditional UI. Read more: https://simplewebauthn.dev/docs/packages/browser#browser-autofill-aka-conditional-ui
  extensions, // Optional WebAuthn extensions (e.g., PRF, credProps, largeBlob)
  returnWebAuthnResponse, // Return WebAuthn response and extension results
});
```

### Type Definition

```ts
type signInPasskey = {
    /**
     * Browser autofill, a.k.a. Conditional UI. Read more: https://simplewebauthn.dev/docs/packages/browser#browser-autofill-aka-conditional-ui
    */
    autoFill?: boolean = true
    /**
     * Optional WebAuthn extensions (e.g., PRF, credProps, largeBlob)
     */
    extensions?: AuthenticationExtensionsClientInputs
    /**
     * Return WebAuthn response and extension results
     */
    returnWebAuthnResponse?: boolean
}
```

#### Example Usage [#example-usage]

```ts
import { authClient } from '@/lib/auth-client';

// With post authentication redirect
await authClient.signIn.passkey({
  autoFill: true,
  // Optional extensions
  extensions: { credProps: true },
  fetchOptions: {
    onSuccess(context) {
      // Redirect to dashboard after successful authentication
      window.location.href = '/dashboard';
    },
    onError(context) {
      // Handle authentication errors
      console.error('Authentication failed:', context.error.message);
    },
  },
});
```

### Extensions [#extensions]

You can use WebAuthn extensions through the client API by passing `extensions`. When `returnWebAuthnResponse` is true, the client returns `webauthn.clientExtensionResults`.

```ts
const result = await authClient.passkey.addPasskey({
  name: 'My Passkey',
  extensions: {
    // Example extension input (generic)
    credProps: true,
  },
  returnWebAuthnResponse: true,
});

console.log(result.webauthn?.clientExtensionResults);
```

### List passkeys [#list-passkeys]

You can list all of the passkeys for the authenticated user by calling `passkey.listUserPasskeys`:

**Endpoint:** `GET /passkey/list-user-passkeys`

### Client Side

```ts
const { data: passkeys, error } = await authClient.passkey.listUserPasskeys();
```

### Server Side

```ts
const passkeys = await auth.api.listPasskeys({
  // This endpoint requires session cookies.
  headers: await headers(),
});
```

### Type Definition

```ts
type listPasskeys = {};
```

### Naming passkeys by authenticator [#naming-passkeys-by-authenticator]

When a user registers a passkey without naming it, the stored `name` is left empty. You can show a friendly default in your UI instead, derived from the authenticator that created the credential.

Every passkey row carries an `aaguid`, the identifier of the authenticator _model_ (for example Google Password Manager or 1Password). Better Auth stores it at registration and returns it from `listPasskeys`, so you resolve a label at the point you render passkeys. Because resolution happens at read time, an updated provider list applies to passkeys that already exist.

The plugin ships a small, best-effort lookup for the most common authenticators:

```ts title="passkey-list.tsx"
import { getAuthenticatorName } from '@better-auth/passkey';

const passkeys = await authClient.passkey.listUserPasskeys();

for (const passkey of passkeys.data ?? []) {
  const label =
    passkey.name || getAuthenticatorName(passkey.aaguid) || 'Passkey';
}
```

The built-in list is intentionally small and not authoritative. Many authenticators are missing, and privacy-preserving platforms report an all-zero AAGUID that resolves to nothing (Apple devices do this under the default `attestation: "none"` flow). Extend it with the exported `commonAuthenticatorNames` map, or resolve against the community-maintained source for full coverage:

- [passkeydeveloper/passkey-authenticator-aaguids](https://github.com/passkeydeveloper/passkey-authenticator-aaguids)

```ts title="passkey-list.tsx"
import { commonAuthenticatorNames } from '@better-auth/passkey';

const names = { ...commonAuthenticatorNames, 'your-aaguid': 'Your Provider' };
```

To set a default label on the server at registration time, return a `name` from `registration.afterVerification`. The AAGUID is available on `verification.registrationInfo.aaguid`, and a client-supplied name always takes precedence:

```ts title="auth.ts"
import { getAuthenticatorName, passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';

export const auth = betterAuth({
  plugins: [
    passkey({
      registration: {
        afterVerification: async ({ verification }) => ({
          name: getAuthenticatorName(verification.registrationInfo?.aaguid),
        }),
      },
    }),
  ],
});
```

### Deleting passkeys [#deleting-passkeys]

You can delete a passkey by calling `passkey.delete` and providing the passkey ID.

<Callout type="warn">
  **This deployment serves this path itself, not from the plugin.** A passkey here is a second factor, so `POST /passkey/delete-passkey` (`lib/auth/two-factor-enrolment.ts`) needs the re-authentication grant from `POST /two-factor/passkey/grant` in the body, refuses the last passkey of a passkey-only account with `409` (the same last-method rule as `/two-factor/methods/disable`), and when the last passkey goes while another method remains it also removes the `passkey` method and revokes every trusted device. The response is this application's envelope, `{ success: true, data: { deleted: true } }`, not the plugin's `{ status: true }`.
</Callout>

**Endpoint:** `POST /passkey/delete-passkey`

### Client Side

```ts
const { data, error } = await authClient.passkey.deletePasskey({
  id: 'some-passkey-id', // required, The ID of the passkey to delete.
});
```

### Server Side

```ts
const data = await auth.api.deletePasskey({
  body: {
    id: 'some-passkey-id', // required, The ID of the passkey to delete.
  },
  // This endpoint requires session cookies.
  headers: await headers(),
});
```

### Type Definition

```ts
type deletePasskey = {
    /**
     * The ID of the passkey to delete.
     */
    id: string = "some-passkey-id"
}
```

### Updating passkey names [#updating-passkey-names]

**Endpoint:** `POST /passkey/update-passkey`

### Client Side

```ts
const { data, error } = await authClient.passkey.updatePasskey({
  id: 'id of passkey', // required, The ID of the passkey which you want to update.
  name: 'my-new-passkey-name', // required, The new name which the passkey will be updated to.
});
```

### Server Side

```ts
const data = await auth.api.updatePasskey({
  body: {
    id: 'id of passkey', // required, The ID of the passkey which you want to update.
    name: 'my-new-passkey-name', // required, The new name which the passkey will be updated to.
  },
  // This endpoint requires session cookies.
  headers: await headers(),
});
```

### Type Definition

```ts
type updatePasskey = {
    /**
     * The ID of the passkey which you want to update.
     */
    id: string = "id of passkey"
    /**
     * The new name which the passkey will be updated to.
     */
    name: string = "my-new-passkey-name"
}
```

### Conditional UI [#conditional-ui]

The plugin supports conditional UI, which allows the browser to autofill the passkey if the user has already registered a passkey.

There are two requirements for conditional UI to work:

<Steps>
  <Step>
    #### Update input fields [#update-input-fields]

    Add the `autocomplete` attribute with the value `webauthn` to your input fields. You can add this attribute to multiple input fields, but at least one is required for conditional UI to work.

    The `webauthn` value should also be the last entry of the `autocomplete` attribute.

    ```html
    <label for="name">Username:</label>
    <input type="text" name="name" autocomplete="username webauthn">
    <label for="password">Password:</label>
    <input type="password" name="password" autocomplete="current-password webauthn">
    ```

  </Step>

  <Step>
    #### Preload the passkeys [#preload-the-passkeys]

    When your component mounts, you can preload the user's passkeys by calling the `authClient.signIn.passkey` method with the `autoFill` option set to `true`.

    To prevent unnecessary calls, we will also add a check to see if the browser supports conditional UI.

    <Tabs items="[&#x22;React&#x22;]">
      <Tab value="React">
        ```ts
        useEffect(() => {
           if (!PublicKeyCredential.isConditionalMediationAvailable ||
               !PublicKeyCredential.isConditionalMediationAvailable()) {
             return;
           }

          void authClient.signIn.passkey({ autoFill: true })
        }, [])
        ```
      </Tab>
    </Tabs>

  </Step>
</Steps>

Depending on the browser, a prompt will appear to autofill the passkey. If the user has multiple passkeys, they can select the one they want to use.

Some browsers also require the user to first interact with the input field before the autofill prompt appears.

### Debugging [#debugging]

To test your passkey implementation you can use [emulated authenticators](https://developer.chrome.com/docs/devtools/webauthn). This way you can test the registration and sign-in process without even owning a physical device.

## Schema [#schema]

The plugin require a new table in the database to store passkey data.

Table Name: `passkey`

<DatabaseTable name="passkey" fields="passkeyTableFields" />

## Options [#options]

**rpID**: A unique identifier for your website based on your auth server origin.
`'localhost'` is okay for local dev. RP ID can be formed by discarding zero or more labels from the left of its effective domain
until it hits an effective TLD. So `www.example.com` can use the RP IDs `www.example.com` or `example.com`. But not `com`, because that's an eTLD.

**rpName**: Human-readable title for your website.

**origin**: The origin URL at which your better-auth server is hosted. `http://localhost` and `http://localhost:PORT` are also valid. Do NOT include any trailing /.

**authenticatorSelection**: Allows customization of WebAuthn authenticator selection criteria. Leave unspecified for default settings.

- `authenticatorAttachment`: Specifies the type of authenticator
  - `platform`: Authenticator is attached to the platform (e.g., fingerprint reader)
  - `cross-platform`: Authenticator is not attached to the platform (e.g., security key)
  - Default: `not set` (both platform and cross-platform allowed, with platform preferred)
- `residentKey`: Determines credential storage behavior.
  - `required`: User MUST store credentials on the authenticator (highest security)
  - `preferred`: Encourages credential storage but not mandatory
  - `discouraged`: No credential storage required (fastest experience)
  - Default: `preferred`
- `userVerification`: Controls biometric/PIN verification during authentication:
  - `required`: User MUST verify identity (highest security)
  - `preferred`: Verification encouraged but not mandatory
  - `discouraged`: No verification required (fastest experience)
  - Default: `preferred`

**advanced**: Advanced options

- `webAuthnChallengeCookie`: Cookie name for storing WebAuthn challenge ID during authentication flow (Default: `better-auth-passkey`)

## Expo Integration [#expo-integration]

When using the passkey plugin with Expo, you need to configure the `cookiePrefix` option in the Expo client to ensure passkey cookies are properly detected and stored.

By default, the passkey plugin uses `"better-auth-passkey"` as the challenge cookie name. Since this starts with `"better-auth"`, it will work with the default Expo client configuration. However, if you customize the `webAuthnChallengeCookie` option, you must also update the `cookiePrefix` in your Expo client configuration.

### Example Configuration [#example-configuration]

If you're using a custom cookie name:

```ts title="Server: auth.ts"
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';

export const auth = betterAuth({
  plugins: [
    passkey({
      advanced: {
        webAuthnChallengeCookie: 'my-app-passkey', // Custom cookie name
      },
    }),
  ],
});
```

Make sure to configure your Expo client with the matching prefix:

```ts title="Client: auth-client.ts"
import { expoClient } from '@better-auth/expo/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';

export const authClient = createAuthClient({
  baseURL: 'http://localhost:8081',
  plugins: [
    expoClient({
      storage: SecureStore,
      cookiePrefix: 'my-app', // Must match the prefix of your custom cookie name
    }),
    passkeyClient(),
  ],
});
```

If you're using multiple authentication systems or custom cookie names, you can provide an array of prefixes:

```ts title="Client: auth-client.ts"
expoClient({
  storage: SecureStore,
  cookiePrefix: ['better-auth', 'my-app', 'custom-auth'],
});
```

<Callout type="warn">
  If the `cookiePrefix` doesn't match the prefix of your `webAuthnChallengeCookie`, the passkey authentication flow will fail because the challenge cookie won't be stored and sent back to the server during verification.
</Callout>

For more information on Expo integration, see the [Expo documentation](/docs/integrations/expo).
