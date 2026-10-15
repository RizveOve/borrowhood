const { db } = require('./db');

const itemQuery = db.prepare(`
  SELECT i.*, u.name AS owner_name, u.flat AS owner_flat, u.email AS owner_email,
         u.neighbourhood_id AS owner_hood, n.name AS hood_name
  FROM items i JOIN users u ON u.id = i.owner_id
  LEFT JOIN neighbourhoods n ON n.id = u.neighbourhood_id
  WHERE i.id = ?`);

const getItem = (id) => itemQuery.get(Number(id) || 0);

function canManage(user, item) {
  return user.role === 'admin' || item.owner_id === user.id;
}

module.exports = { getItem, canManage };
