"""The public-fixture approval option remains discoverable and repeatable."""
from click.testing import CliRunner
from scripts.prodclone_extract import cli, from_config


def test_public_fixture_approval_option():
    result = CliRunner().invoke(cli, ['from-config', '--help'])
    assert result.exit_code == 0, result.output
    assert '--accept-public-fixture' in result.output
    option = next(p for p in from_config.params if p.name == 'accept_public_fixture')
    assert option.multiple
