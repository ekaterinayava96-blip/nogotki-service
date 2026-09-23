import asyncio

import payments


async def main():
    pid, url = await payments.create_payment(
        100, "Проверка связки ЮKassa", order_id=0
    )
    print("payment_id:", pid)
    print("confirmation_url:", url)
    status = await payments.get_payment_status(pid)
    print("status:", status)


asyncio.run(main())