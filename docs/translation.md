# Translation

**Mojito** is the translation management system (TMS) that we use for Polis.

As much as possible, we try to manage localization from our continuous integration scripts, performed via GitHub Actions workflows.

## Adding a new project

A project (aka _repository_ in Mojito's terminology) is a component with a set of localizations, e.g., `client-admin`.

2. Note the path of the project's `strings` directory in this repo.
3. Update [`.github/workflows/push-translations.yml`][push-workflow]
    - Add appropriate paths to `on.push.paths`.
    - Add new entry to the `PROJECTS` envvar of step `Ensure translation projects exist`.
      - The will ensure the project exists on the Mojito server.
    - Add new command to step `Update available locales`.
    - Add new command to step `Push translations to Mojito server`.
4. Update [`.github/workflows/pull-translations.yml`][pull-workflow]
    - Add appropriate paths to `on.push.paths`.
    - Add new command to step `Pull translations from Mojito server`.

   [push-workflow]: /.github/workflows/push-translations.yml
   [pull-workflow]: /.github/workflows/pull-translations.yml

## Adding a new language

To add an additional language (aka _locale_ in Mojito terminology) to a project.

1. Consult the [Mojito's list of available locales][locales].
    - If your locale is not available, you'll need to engage with the lead developer in [Mojito's Gitter chatroom][chat], and nicely request that it be added.
2. Add your locale to the appropriate list in the "Update available locales" step of [this workflow](/.github/workflows/push-translations.yml#L48).
3. Submit a pull request to the project.
    - Your changes will come into effect shortly after we merge your pull request.

   [locales]: https://www.mojito.global/docs/refs/mojito-locales/
   [chat]: https://gitter.im/box/mojito

## Change the Mojito admin password

1. Change the password on the Mojito localization server.
    - See the [`make change-password` task][change-password] within the [`patcon/polis-translations` repo][repo].
2. Update the `MOJITO_CLI_PASSWORD` secret envvar within the `pol-is/polis`
   repo's settings.
     - This ensures that GitHub Action workflows can continue to run.

   [change-password]: https://github.com/patcon/polis-translations/blob/2cdcd8a4a9acf8f46efe82cd89a0f2c141dccd75/Makefile#L74-L81
   [repo]: https://github.com/patcon/polis-translations
