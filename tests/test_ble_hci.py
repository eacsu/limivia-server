"""ATT 错误响应、断连与接口隔离不能被算成成功业务请求。"""

import importlib.util
import json
from pathlib import Path

import pytest


def test_hci_summary_pairs_att_errors_and_discards_packet_data():
    path = Path(__file__).parents[1] / "scripts" / "analyze_ble_hci.py"
    spec = importlib.util.spec_from_file_location("analyze_ble_hci", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    lines = """
< ACL Data TX: Handle 65 flags 0x00 dlen 30 #1 [hci1] 1.000000
      ATT: Write Request (0x12) len 21
        Data: private-payload-must-not-be-exported
> ACL Data RX: Handle 65 flags 0x02 dlen 5 #2 [hci1] 1.100000
      ATT: Write Response (0x13) len 0
< ACL Data TX: Handle 65 flags 0x00 dlen 30 #3 [hci1] 2.000000
      ATT: Write Request (0x12) len 21
> ACL Data RX: Handle 65 flags 0x02 dlen 9 #4 [hci1] 2.200000
      ATT: Error Response (0x01) len 4
< ACL Data TX: Handle 65 flags 0x00 dlen 7 #5 [hci1] 3.000000
      ATT: Read Request (0x0a) len 2
> HCI Event: Disconnect Complete (0x05) plen 4 #6 [hci1] 3.100000
> ACL Data RX: Handle 65 flags 0x02 dlen 7 #7 [hci1] 3.200000
      ATT: Read Response (0x0b) len 2
< ACL Data TX: Handle 65 flags 0x00 dlen 30 #8 [hci0] 4.000000
      ATT: Write Request (0x12) len 21
> ACL Data RX: Handle 65 flags 0x02 dlen 5 #9 [hci0] 4.500000
      ATT: Write Response (0x13) len 0
""".splitlines()
    result = module.analyze(lines)
    assert result["operations"]["write"]["n"] == 2
    assert result["operations"]["write"]["mean_ms"] == pytest.approx(150)
    assert result["operations"]["write"]["att_error_responses"] == 1
    assert result["abandoned_at_disconnect"] == 1
    assert result["pending_at_capture_end"] == 0
    assert "read" not in result["operations"]
    assert "private-payload" not in json.dumps(result)
