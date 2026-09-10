import unittest
from datetime import datetime, timezone

import scrape

SAMPLE = """
<div class="sb-parking-info">
  <!--<span>- 0.0 Km fins a la teva ubicació</span>-->
  <div class="available-places">Places: <strong>297</strong>    | Places disponibles: <strong>  230</strong></div>
</div>
"""


class ParseTests(unittest.TestCase):
    def test_parse_extracts_capacity_and_available(self):
        self.assertEqual(scrape.parse(SAMPLE), (297, 230))

    def test_parse_fails_without_block(self):
        with self.assertRaises(scrape.ParseError):
            scrape.parse("<html><body>res</body></html>")

    def test_parse_rejects_available_above_capacity(self):
        bad = SAMPLE.replace("230", "999")
        with self.assertRaises(scrape.ParseError):
            scrape.parse(bad)

    def test_csv_path_uses_local_date(self):
        # 23:30 UTC del 11 de setembre són les 01:30 del dia 12 a Terrassa.
        slot = datetime(2026, 9, 11, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(scrape.csv_path_for(slot).name, "2026-09-12.csv")


if __name__ == "__main__":
    unittest.main()
