<?php
namespace Shop;

class Orders
{
    public function __construct(private \PDO $db) {}

    // A.8.28 violation: interpolated request value.
    public function findByEmail(): array
    {
        $email = $_GET['email'];
        $sql = "SELECT * FROM orders WHERE email = '" . $email . "'";
        return $this->db->query($sql)->fetchAll();
    }

    public function deleteOld(int $days): int
    {
        return $this->db->exec("DELETE FROM orders WHERE created_at < NOW() - INTERVAL {$days} DAY");
    }
}
