import math

def add(x, y):
    return x + y

def subtract(x, y):
    return x - y

def multiply(x, y):
    return x * y

def divide(x, y):
    if y == 0:
        raise ValueError("Деление на ноль невозможно")
    return x / y

def power(x, y):
    return x ** y

def square_root(x):
    if x < 0:
        raise ValueError("Невозможно извлечь корень из отрицательного числа")
    return math.sqrt(x)

def calculator():
    print("Простой калькулятор")
    print("Операции: +, -, *, /, **, sqrt")
    print("Для выхода введите 'quit'")
    
    while True:
        try:
            operation = input("\nВведите операцию (+, -, *, /, **, sqrt) или 'quit' для выхода: ").strip()
            
            if operation.lower() == 'quit':
                print("До свидания!")
                break
            
            if operation == 'sqrt':
                num = float(input("Введите число: "))
                result = square_root(num)
                print(f"√{num} = {result}")
            elif operation in ['+', '-', '*', '/', '**']:
                num1 = float(input("Введите первое число: "))
                num2 = float(input("Введите второе число: "))
                
                if operation == '+':
                    result = add(num1, num2)
                elif operation == '-':
                    result = subtract(num1, num2)
                elif operation == '*':
                    result = multiply(num1, num2)
                elif operation == '/':
                    result = divide(num1, num2)
                elif operation == '**':
                    result = power(num1, num2)
                
                print(f"{num1} {operation} {num2} = {result}")
            else:
                print("Неизвестная операция. Используйте: +, -, *, /, **, sqrt")
                
        except ValueError as e:
            print(f"Ошибка: {e}")
        except Exception as e:
            print(f"Непредвиденная ошибка: {e}")

if __name__ == "__main__":
    calculator()