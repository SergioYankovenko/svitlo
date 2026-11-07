import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('svitlo_switch',Path(__file__).with_name('switch.py'));switch=importlib.util.module_from_spec(spec);spec.loader.exec_module(switch)
class RollbackAnchor(unittest.TestCase):
 def test_new_release_retains_the_actual_previous_release(self):
  self.assertEqual(switch.rollback_anchor('/releases/3','/releases/2',json.dumps({'previousRelease':'/releases/1'}),'/releases/1\n'),'/releases/2')
 def test_same_image_restart_preserves_prior_release(self):
  self.assertEqual(switch.rollback_anchor('/releases/2','/releases/2',json.dumps({'previousRelease':'/releases/1'}),'/releases/1\n'),'/releases/1')
 def test_missing_anchor_refuses_restart_instead_of_pointing_rollback_at_itself(self):
  with self.assertRaises(RuntimeError):switch.rollback_anchor('/releases/2','/releases/2',json.dumps({'previousRelease':'/releases/2'}),'/releases/2\n')
if __name__=='__main__':unittest.main()
