import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('host_agent',Path(__file__).with_name('host-agent.py'));agent=importlib.util.module_from_spec(spec);spec.loader.exec_module(agent)
class HostLogTest(unittest.TestCase):
 def test_secrets_and_identifiers_never_enter_console(self):
  import json
  row=agent.public_log(json.dumps({'event':'request_failed','status':503,'ms':10,'password':'not-exported','url':'private-url','owner':'private-owner'}),'api')
  self.assertEqual(row,{'service':'api','event':'request_failed','status':503,'duration_ms':10})
 def test_unknown_or_unstructured_logs_are_not_exported(self):
  self.assertIsNone(agent.public_log('unstructured sensitive line','worker'))
  self.assertIsNone(agent.public_log('{"event":"unknown_name","payload":"private"}','worker'))
if __name__=='__main__':unittest.main()
