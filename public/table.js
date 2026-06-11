// Progressive enhancement: click-to-sort + substring filter for .data tables.
// ~1.3KB, no dependencies; the page is fully readable without it.
(function () {
  "use strict";
  function cellKey(td) {
    var k = td.getAttribute("data-k");
    return k !== null ? k : td.textContent.trim();
  }
  document.querySelectorAll("table.data").forEach(function (table) {
    var ths = table.querySelectorAll("thead th");
    ths.forEach(function (th, idx) {
      th.addEventListener("click", function () {
        var dir = th.getAttribute("data-sorted") === "asc" ? "desc" : "asc";
        ths.forEach(function (o) { o.removeAttribute("data-sorted"); });
        th.setAttribute("data-sorted", dir);
        var tbody = table.tBodies[0];
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (a, b) {
          var x = cellKey(a.cells[idx]), y = cellKey(b.cells[idx]);
          var nx = parseFloat(x), ny = parseFloat(y);
          var r;
          if (!isNaN(nx) && !isNaN(ny)) r = nx - ny;
          else r = x.localeCompare(y);
          if (x === "" && y !== "") r = 1; else if (y === "" && x !== "") r = -1;
          return dir === "asc" ? r : -r;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
  });
  document.querySelectorAll("input.filter").forEach(function (input) {
    var table = document.getElementById(input.getAttribute("data-table"));
    if (!table) return;
    input.addEventListener("input", function () {
      var q = input.value.toLowerCase();
      Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
        row.style.display =
          row.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none";
      });
    });
  });
})();
