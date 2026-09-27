import unittest
from unittest.mock import patch
from math_kernel import environment, configure


class KernelTest(unittest.TestCase):
    def test_linux_forces_haswell_and_preserves_other_environment(self):
        self.assertEqual(environment({'OPENBLAS_CORETYPE':'SkylakeX','X':'1'},'Linux','x86_64'),
                         {'OPENBLAS_CORETYPE':'Haswell','X':'1'})

    def test_arm_records_unforced_and_removes_inherited_x86_kernel(self):
        for system,machine in [('Linux','aarch64'),('Darwin','arm64')]:
            self.assertEqual(environment({'OPENBLAS_CORETYPE':'Haswell'},system,machine),{})

    def test_configuration_precedes_numerical_import(self):
        with patch.dict('os.environ',{'OPENBLAS_CORETYPE':'wrong'},clear=True), \
             patch('platform.system',return_value='Linux'),patch('platform.machine',return_value='x86_64'):
            configure()
            import os
            self.assertEqual(os.environ['OPENBLAS_CORETYPE'],'Haswell')
