# Installed T3 Code Electron profile path

The installed AppImage is T3 Code `0.0.46-nightly.20261011.2980`, built from
commit [`ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`](https://github.com/pingdotgg/t3code/commit/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e).
The AppImage's `resources/app.asar/package.json` reports that exact version and
`t3codeCommitHash: "ed0f7b908b2e"`. Its bundled
`apps/desktop/dist-electron/main.cjs` also contains the profile-selection and
Electron startup code described below. This runtime bundle is the direct evidence
for what the installed package does; the desktop entry's displayed name is not
used to derive this path.

For packaged, non-development Linux runs, the app's
[`DesktopEnvironment.ts`](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/desktop/src/app/DesktopEnvironment.ts#L159-L166)
sets `appDataDirectory` to `XDG_CONFIG_HOME` when configured, otherwise to
`$HOME/.config`. The pinned
[`DesktopUserData.ts`](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/desktop/src/app/DesktopUserData.ts#L36-L57)
chooses `t3code-v2` as the packaged profile name and returns
`path.join(appDataDirectory, "t3code-v2")` for every non-Windows platform. In
the installed bundle, startup passes that resolved path to Electron's
`app.setPath("userData", userDataPath)` before lifecycle registration.

Therefore the exact Linux user-data path is:

```text
${XDG_CONFIG_HOME}/t3code-v2     when XDG_CONFIG_HOME is set
${HOME}/.config/t3code-v2       otherwise
```

The observed `~/.config/t3code-v2` is thus consistent with the app's source-defined
default, conditional on no `XDG_CONFIG_HOME` override. The bundle explicitly
separates this Chromium/Electron profile from T3's server state directory, which
is why the desktop label `T3 Code (Alpha)` and legacy-profile handling do not
identify the active profile path.

Investigation was read-only: the AppImage was not launched and no installed files
or databases were modified. The extracted bundle used for inspection was under
`/tmp/t3-inspect`; exact source and version identity are pinned above so future
verification does not depend on that temporary extraction remaining available.
