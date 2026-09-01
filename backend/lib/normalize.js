// Query normalization — must mirror the SQL normalization used for matching:
// lowercase, strip accents, collapse non-alphanumerics to single spaces, trim.
function normalize(s) {
  return (s == null ? "" : String(s))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

module.exports = { normalize };
